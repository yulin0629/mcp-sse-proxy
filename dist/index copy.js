#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE and SSE over stdio.
 * Also supports aggregating multiple servers from a config file into a single SSE endpoint.
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y @srbhptl39/mcp-superassistant-proxy --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE -> stdio
 *   npx -y @srbhptl39/mcp-superassistant-proxy --sse "https://abc.xyz.app"
 *
 *   # SSE -> SSE
 *   npx -y @srbhptl39/mcp-superassistant-proxy --port 3007 --ssetosse "https://abc.xyz.app"
 *
 *   # Config file with multiple servers -> SSE
 *   npx -y @srbhptl39/mcp-superassistant-proxy --config ./config.json --port 3007
 */
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { spawn } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Define Zod schemas for config validation
const StdioServerConfigSchema = z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    disabled: z.boolean().optional().default(false),
    autoApprove: z.array(z.string()).optional().default([]),
});
const SseServerConfigSchema = z.object({
    url: z.string().url(),
    disabled: z.boolean().optional().default(false),
    autoApprove: z.array(z.string()).optional().default([]),
});
// Use discriminated union to make type checking easier
const ServerConfigSchema = z.discriminatedUnion("type", [
    StdioServerConfigSchema.extend({ type: z.literal("stdio") }),
    SseServerConfigSchema.extend({ type: z.literal("sse") }),
]);
// --- Allow config without explicit type ---
// We'll infer the type based on properties later
const InferredServerConfigSchema = z.union([
    StdioServerConfigSchema.extend({ url: z.undefined().optional() }), // stdio has command, not url
    SseServerConfigSchema.extend({ command: z.undefined().optional() }) // sse has url, not command
]).refine(config => ('command' in config && config.command) || ('url' in config && config.url), {
    message: "Server config must have either 'command' or 'url'"
});
const ConfigSchema = z.object({
    mcpServers: z.record(InferredServerConfigSchema) // Use inferred schema here
});
// --- End config without explicit type ---
function getVersion() {
    try {
        const packageJsonPath = join(__dirname, '../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        return packageJson.version || 'unknown';
    }
    catch (err) {
        console.error('[mcp-superassistant-proxy]', 'Unable to retrieve version:', err);
        return 'unknown';
    }
}
const log = (...args) => console.log('[mcp-superassistant-proxy]', ...args);
const logStderr = (...args) => console.error('[mcp-superassistant-proxy]', ...args);
const noneLogger = {
    info: () => { },
    error: () => { },
    warn: () => { }
};
// Adapter for stdio servers
class StdioServerAdapter {
    child = null;
    serverName;
    command;
    args;
    env;
    disabled;
    autoApproveList;
    logger;
    buffer = '';
    messageCallback;
    fetchedTools = null;
    constructor(serverName, config, logger) {
        this.serverName = serverName;
        this.command = config.command;
        this.args = config.args || [];
        this.env = config.env || {};
        this.disabled = config.disabled ?? false;
        this.autoApproveList = config.autoApprove || [];
        this.logger = logger;
    }
    async initialize() {
        if (this.disabled) {
            this.logger.info(`[${this.serverName}] Server is disabled, skipping initialization.`);
            return;
        }
        if (this.child) {
            this.logger.info(`[${this.serverName}] Already initialized.`);
            return;
        }
        // Wrap in a promise that resolves only after attempting to fetch capabilities
        return new Promise((resolveOuter, rejectOuter) => {
            const mergedEnv = { ...process.env, ...this.env };
            this.logger.info(`[${this.serverName}] Spawning: ${this.command} ${this.args.join(' ')}`);
            try {
                this.child = spawn(this.command, this.args, { shell: true, env: mergedEnv });
            }
            catch (spawnErr) {
                this.logger.error(`[${this.serverName}] Failed to spawn process during initialization:`, spawnErr);
                return rejectOuter(spawnErr); // Reject the outer promise immediately
            }
            // --- Capability Fetch Logic --- 
            const toolsListRequestId = `proxy-init-tools-${this.serverName}-${Date.now()}`;
            let toolsListPromiseResolver = () => { }; // Initialize to satisfy linter
            const toolsListPromise = new Promise((resolve) => {
                toolsListPromiseResolver = resolve;
            });
            let timeoutId = null;
            let initializationFinished = false; // Flag to prevent race conditions on exit/error
            const finishInitialization = (error) => {
                if (initializationFinished)
                    return;
                initializationFinished = true;
                if (timeoutId)
                    clearTimeout(timeoutId);
                this.child?.stdout.removeAllListeners('data'); // Clean up specific listener if needed
                this.child?.stderr.removeAllListeners('data');
                this.child?.removeAllListeners('error');
                this.child?.removeAllListeners('exit');
                this.child?.removeAllListeners('spawn');
                if (error) {
                    rejectOuter(error);
                }
                else {
                    resolveOuter();
                }
            };
            // --- End Capability Fetch Logic --- 
            this.child.on('spawn', () => {
                this.logger.info(`[${this.serverName}] Process spawned successfully. Fetching tools list...`);
                // Start timeout for capability fetch
                timeoutId = setTimeout(() => {
                    this.logger.warn(`[${this.serverName}] Timed out waiting for tools/list response after 30s.`);
                    if (toolsListPromiseResolver)
                        toolsListPromiseResolver(false); // Resolve promise indicating failure
                    // Do NOT call finishInitialization here, let the await toolsListPromise handle it
                }, 30000); // 30 second timeout
                // Send tools/list request
                const request = { jsonrpc: '2.0', id: toolsListRequestId, method: 'tools/list' };
                this.logger.info(`[${this.serverName}] Sending initial tools/list request:`, JSON.stringify(request));
                try {
                    this.child.stdin.write(JSON.stringify(request) + '\n');
                }
                catch (writeErr) {
                    this.logger.error(`[${this.serverName}] Error writing initial tools/list request to stdin:`, writeErr);
                    if (timeoutId)
                        clearTimeout(timeoutId);
                    if (toolsListPromiseResolver)
                        toolsListPromiseResolver(false); // Mark as failed
                    // Do NOT call finishInitialization here, let the await toolsListPromise handle it
                }
                // Don't resolveOuter() here, wait for tools/list response or timeout
            });
            this.child.on('error', (err) => {
                this.logger.error(`[${this.serverName}] Failed to spawn process or runtime error:`, err);
                this.child = null; // Ensure child is null on error
                finishInitialization(err); // Reject the outer promise
            });
            this.child.on('exit', (code, signal) => {
                this.logger.error(`[${this.serverName}] Child process exited unexpectedly during initialization: code=${code}, signal=${signal}`);
                this.child = null; // Ensure child is null on exit
                finishInitialization(new Error(`Child process exited prematurely (code=${code}, signal=${signal})`));
            });
            // Setup stdout handler - modified for initial capability fetch
            this.child.stdout.on('data', (chunk) => {
                if (initializationFinished)
                    return; // Don't process if already finished
                this.buffer += chunk.toString('utf8');
                const lines = this.buffer.split(/\r?\n/);
                this.buffer = lines.pop() ?? '';
                lines.forEach(line => {
                    if (!line.trim())
                        return;
                    try {
                        const jsonMsg = JSON.parse(line);
                        // Check if it's the response to our tools/list request
                        if ('id' in jsonMsg && jsonMsg.id === toolsListRequestId) {
                            if (timeoutId)
                                clearTimeout(timeoutId); // Clear timeout
                            this.logger.info(`[${this.serverName}] Received tools/list response:`, JSON.stringify(jsonMsg));
                            // Check for result *after* confirming it's a potential response
                            if ('result' in jsonMsg && jsonMsg.result && Array.isArray(jsonMsg.result.tools)) {
                                this.fetchedTools = jsonMsg.result.tools;
                                this.logger.info(`[${this.serverName}] Successfully stored ${jsonMsg.result.tools.length} tools from initial fetch.`);
                                // Check for error *after* confirming it's a potential response
                            }
                            else if ('error' in jsonMsg && jsonMsg.error) {
                                this.logger.error(`[${this.serverName}] Received error in tools/list response:`, jsonMsg.error);
                            }
                            else {
                                this.logger.warn(`[${this.serverName}] Received invalid tools/list response structure.`, jsonMsg);
                            }
                            if (toolsListPromiseResolver)
                                toolsListPromiseResolver(true); // Resolve promise indicating completion
                            // Don't forward this specific response via messageCallback
                        }
                        else {
                            // Forward other messages if a callback is registered
                            this.logger.info(`[${this.serverName}] Received (forwarding):`, JSON.stringify(jsonMsg));
                            this.messageCallback?.(jsonMsg);
                        }
                    }
                    catch (err) {
                        this.logger.error(`[${this.serverName}] non-JSON stdout during init: ${line}`, err);
                    }
                });
            });
            // Setup stderr handler
            this.child.stderr.on('data', (chunk) => {
                if (initializationFinished)
                    return; // Don't process if already finished
                this.logger.error(`[${this.serverName}] stderr during init: ${chunk.toString('utf8').trim()}`);
            });
            // Add the final step to wait for capability fetch and resolve outer promise
            Promise.resolve().then(async () => {
                try {
                    await toolsListPromise; // Wait for the tools/list attempt to finish (success, failure, timeout)
                    // Now that capability fetch is done (or timed out), setup the regular message handling
                    this.logger.info(`[${this.serverName}] Finished capability fetching phase. Setting up standard message handling.`);
                    // Re-attach stdout listener for normal operation AFTER capability fetch is done
                    this.child?.stdout.removeAllListeners('data'); // Remove the init-specific handler
                    this.child?.stdout.on('data', this.handleStdOutData);
                    // Re-attach stderr listener for normal operation
                    this.child?.stderr.removeAllListeners('data');
                    this.child?.stderr.on('data', this.handleStdErrData);
                    // Re-attach exit listener for normal operation
                    this.child?.removeAllListeners('exit');
                    this.child?.on('exit', (code, signal) => {
                        this.logger.error(`[${this.serverName}] Child process exited: code=${code}, signal=${signal}`);
                        this.child = null; // Ensure child is null on exit
                        // Optionally notify about the exit via messageCallback or a dedicated handler
                    });
                    finishInitialization(); // Resolve the main initialize promise
                }
                catch (err) {
                    // This catch might not be strictly necessary if toolsListPromise doesn't reject
                    this.logger.error(`[${this.serverName}] Error during capability fetch promise handling:`, err);
                    finishInitialization(err instanceof Error ? err : new Error(String(err)));
                }
            });
        }); // End outer promise wrapper
    }
    // Separate stdout handler for regular operation
    handleStdOutData = (chunk) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        lines.forEach(line => {
            if (!line.trim())
                return;
            try {
                const jsonMsg = JSON.parse(line);
                // Check if it's the response to our tools/list request ID - SHOULD NOT HAPPEN HERE
                // if ('id' in jsonMsg && jsonMsg.id === this.toolsListRequestId) {             
                //    // ... handle response ...
                // } else {
                // Forward other messages if a callback is registered
                this.logger.info(`[${this.serverName}] Received:`, JSON.stringify(jsonMsg));
                this.messageCallback?.(jsonMsg); // Forward the message
                // }
            }
            catch (err) {
                this.logger.error(`[${this.serverName}] non-JSON stdout: ${line}`, err);
            }
        });
    };
    // Separate stderr handler for regular operation
    handleStdErrData = (chunk) => {
        this.logger.error(`[${this.serverName}] stderr: ${chunk.toString('utf8').trim()}`);
    };
    send(message) {
        if (this.disabled) {
            // this.logger.info(`[${this.serverName}] Not sending to disabled server`)
            return;
        }
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
            this.logger.error(`[${this.serverName}] Cannot send message, stdin is not available.`);
            return;
        }
        const msgString = JSON.stringify(message) + '\n';
        this.logger.info(`[${this.serverName}] Sending:`, msgString.trim());
        try {
            this.child.stdin.write(msgString);
        }
        catch (err) {
            this.logger.error(`[${this.serverName}] Error writing to stdin:`, err);
        }
    }
    getServerName() {
        return this.serverName;
    }
    getServerType() {
        return 'stdio';
    }
    isDisabled() {
        return this.disabled;
    }
    shouldAutoApprove(toolName) {
        return this.autoApproveList.includes(toolName);
    }
    onMessage(callback) {
        this.messageCallback = callback;
    }
    getFetchedTools() {
        return this.fetchedTools;
    }
    async close() {
        if (this.child) {
            this.logger.info(`[${this.serverName}] Terminating child process.`);
            this.child.kill(); // Send SIGTERM
            this.child = null;
        }
    }
}
// Adapter for SSE servers
class SseServerAdapter {
    client = null;
    transport = null;
    serverName;
    url;
    disabled;
    autoApproveList;
    logger;
    connected = false;
    messageCallback;
    connectionPromise = null;
    fetchedTools = null;
    constructor(serverName, config, logger) {
        this.serverName = serverName;
        this.url = config.url;
        this.disabled = config.disabled ?? false;
        this.autoApproveList = config.autoApprove || [];
        this.logger = logger;
    }
    async initialize() {
        if (this.disabled) {
            this.logger.info(`[${this.serverName}] Server is disabled, skipping initialization.`);
            return;
        }
        if (this.connectionPromise) {
            this.logger.info(`[${this.serverName}] Connection attempt already in progress or completed.`);
            return this.connectionPromise;
        }
        this.connectionPromise = (async () => {
            try {
                this.logger.info(`[${this.serverName}] Connecting to SSE server at ${this.url}...`);
                this.transport = new SSEClientTransport(new URL(this.url));
                this.client = new Client({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} } // Start with basic capabilities
                );
                this.transport.onerror = err => {
                    this.logger.error(`[${this.serverName}] SSE connection error:`, err);
                    this.connected = false;
                    // TODO: Implement retry logic if needed
                };
                this.transport.onclose = () => {
                    this.logger.info(`[${this.serverName}] SSE connection closed.`);
                    this.connected = false;
                    // TODO: Implement retry logic if needed
                };
                // Important: Set onmessage on the transport *before* connecting
                // This ensures messages aren't missed during the connect phase
                this.transport.onmessage = (msg) => {
                    this.logger.info(`[${this.serverName}] Received:`, JSON.stringify(msg));
                    this.messageCallback?.(msg);
                };
                await this.client.connect(this.transport); // This calls transport.start()
                this.connected = true;
                this.logger.info(`[${this.serverName}] Successfully connected via SDK. Now explicitly fetching tools list...`);
                // --- Explicit tools/list fetch for SSE --- 
                const toolsListRequestId = `proxy-init-tools-${this.serverName}-${Date.now()}`;
                let toolsListPromiseResolver = () => { }; // Initialize to satisfy linter
                const toolsListPromise = new Promise((resolve) => {
                    toolsListPromiseResolver = resolve;
                });
                let timeoutId = null;
                // Temporarily override onmessage to intercept the tools/list response
                const originalOnMessage = this.transport.onmessage;
                this.transport.onmessage = (msg) => {
                    // Check if it's the response to our tools/list request
                    if ('id' in msg && msg.id === toolsListRequestId) {
                        if (timeoutId)
                            clearTimeout(timeoutId);
                        this.logger.info(`[${this.serverName}] Received tools/list response:`, JSON.stringify(msg));
                        if ('result' in msg && msg.result && Array.isArray(msg.result.tools)) {
                            this.fetchedTools = msg.result.tools;
                            this.logger.info(`[${this.serverName}] Successfully stored ${msg.result.tools.length} tools from initial fetch.`);
                        }
                        else if ('error' in msg && msg.error) {
                            this.logger.error(`[${this.serverName}] Received error in tools/list response:`, msg.error);
                        }
                        else {
                            this.logger.warn(`[${this.serverName}] Received invalid tools/list response structure.`, msg);
                        }
                        toolsListPromiseResolver(true); // Resolve promise indicating completion
                    }
                    else {
                        // If it wasn't our tools/list response, call the original handler (or the later one)
                        this.logger.info(`[${this.serverName}] Received (init phase, forwarding):`, JSON.stringify(msg));
                        // Check if the final messageCallback is set, otherwise use the original
                        if (this.messageCallback) {
                            this.messageCallback(msg);
                        }
                        else if (originalOnMessage) {
                            originalOnMessage(msg);
                        }
                    }
                };
                // Start timeout
                timeoutId = setTimeout(() => {
                    this.logger.warn(`[${this.serverName}] Timed out waiting for tools/list response after 30s.`);
                    toolsListPromiseResolver(false);
                }, 30000); // 30 second timeout
                // Send tools/list request
                const request = { jsonrpc: '2.0', id: toolsListRequestId, method: 'tools/list' };
                this.logger.info(`[${this.serverName}] Sending initial tools/list request:`, JSON.stringify(request));
                try {
                    // Use transport.send directly, bypassing client request/notification logic for this specific case
                    await this.transport.send(request);
                }
                catch (err) {
                    this.logger.error(`[${this.serverName}] Error sending initial tools/list request:`, err);
                    if (timeoutId)
                        clearTimeout(timeoutId);
                    toolsListPromiseResolver(false);
                }
                // Wait for the response or timeout
                await toolsListPromise;
                this.logger.info(`[${this.serverName}] Finished tools/list fetch attempt.`);
                // Restore original onmessage or set the final one if it exists
                this.transport.onmessage = this.messageCallback || originalOnMessage;
                // --- End explicit tools/list fetch --- 
            }
            catch (err) {
                this.logger.error(`[${this.serverName}] Failed to connect to SSE server:`, err);
                this.connected = false;
                this.transport = null;
                this.client = null;
                this.connectionPromise = null; // Reset promise on failure to allow retry
                throw err; // Re-throw the error to signal initialization failure
            }
        })();
        return this.connectionPromise;
    }
    send(message) {
        if (this.disabled) {
            // this.logger.info(`[${this.serverName}] Not sending to disabled server`)
            return;
        }
        if (!this.connected || !this.transport) {
            this.logger.error(`[${this.serverName}] Cannot send message, not connected.`);
            return;
        }
        this.logger.info(`[${this.serverName}] Sending:`, JSON.stringify(message));
        this.transport.send(message).catch(err => {
            this.logger.error(`[${this.serverName}] Error sending message:`, err);
            // Consider marking as disconnected or attempting reconnect here
            this.connected = false;
        });
    }
    getServerName() {
        return this.serverName;
    }
    getServerType() {
        return 'sse';
    }
    isDisabled() {
        return this.disabled;
    }
    shouldAutoApprove(toolName) {
        return this.autoApproveList.includes(toolName);
    }
    onMessage(callback) {
        this.messageCallback = callback;
        // If already connected, ensure the callback is linked to the transport
        if (this.transport) {
            this.transport.onmessage = (msg) => {
                this.logger.info(`[${this.serverName}] Received:`, JSON.stringify(msg));
                this.messageCallback?.(msg);
            };
        }
    }
    async close() {
        this.connected = false;
        this.connectionPromise = null; // Clear connection promise
        if (this.transport) {
            this.logger.info(`[${this.serverName}] Closing SSE connection.`);
            await this.transport.close();
            this.transport = null;
            this.client = null; // Client is implicitly closed when transport closes
        }
    }
    getFetchedTools() {
        return this.fetchedTools;
    }
}
// --- End Adapter Implementations ---
const onSignals = ({ logger, adapters }) => {
    const cleanup = async (signal) => {
        logger.info(`Caught ${signal}. Cleaning up and exiting...`);
        if (adapters) {
            logger.info(`Closing ${adapters.length} server adapters...`);
            await Promise.allSettled(adapters.map(adapter => adapter.close()));
            logger.info(`Adapters closed.`);
        }
        process.exit(0);
    };
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGHUP', () => cleanup('SIGHUP'));
    process.stdin.on('close', () => {
        logger.info('stdin closed. Exiting...');
        process.exit(0);
    });
};
async function stdioToSse(args) {
    const { stdioCmd, port, baseUrl, ssePath, messagePath, logger, enableCors, healthEndpoints } = args;
    // ... (stdioToSse implementation remains largely the same as before)
    logger.info('Starting stdio-to-sse mode...');
    logger.info(`  - port: ${port}`);
    logger.info(`  - stdio: ${stdioCmd}`);
    // ... rest of the logging ...
    onSignals({ logger }); // Pass empty adapters array or handle differently if needed
    const child = spawn(stdioCmd, { shell: true });
    child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`);
        process.exit(code ?? 1);
    });
    const server = new Server({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} } // Keep simple for single server mode
    );
    const sessions = {};
    const app = express();
    if (enableCors) {
        app.use(cors());
    }
    // Use bodyParser.json() only for non-message paths
    app.use((req, res, next) => {
        if (req.path !== messagePath) {
            bodyParser.json()(req, res, next);
        }
        else {
            next(); // Skip body parsing for the raw message endpoint
        }
    });
    for (const ep of healthEndpoints) {
        app.get(ep, (_req, res) => {
            res.send('ok');
        });
    }
    app.get(ssePath, async (req, res) => {
        logger.info(`New SSE connection from ${req.ip}`);
        const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res);
        await server.connect(sseTransport); // Connects the main server to this client transport
        const sessionId = sseTransport.sessionId;
        sessions[sessionId] = { transport: sseTransport, response: res }; // Store session by ID
        sseTransport.onmessage = (msg) => {
            logger.info(`Client (SSE ${sessionId}) -> Stdio Child: ${JSON.stringify(msg)}`);
            if (child && child.stdin && !child.stdin.destroyed) {
                child.stdin.write(JSON.stringify(msg) + '\n');
            }
            else {
                logger.error("Cannot forward message to stdio child: stdin not available.");
                // Optionally close this SSE connection or notify the client
                sseTransport.close();
            }
        };
        sseTransport.onclose = () => {
            logger.info(`SSE connection closed (session ${sessionId})`);
            delete sessions[sessionId];
        };
        sseTransport.onerror = err => {
            logger.error(`SSE error (session ${sessionId}):`, err);
            delete sessions[sessionId];
        };
        req.on('close', () => {
            logger.info(`Client disconnected (session ${sessionId})`);
            delete sessions[sessionId];
        });
    });
    // Use handlePostMessage which includes body parsing logic
    const handleMessage = (req, res, next) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            res.status(400).send('Missing sessionId parameter');
            return;
        }
        const session = sessions[sessionId];
        if (session?.transport?.handlePostMessage) {
            logger.info(`POST to SSE transport (session ${sessionId})`);
            // handlePostMessage expects raw request and response
            session.transport.handlePostMessage(req, res).catch(err => {
                logger.error(`Error handling message from session ${sessionId}:`, err);
                res.status(500).send('Internal server error');
            });
        }
        else {
            logger.error(`No active SSE transport found for session ${sessionId}, replying 503`);
            res.status(503).send(`No active SSE connection for session ${sessionId}`);
        }
    };
    app.post(messagePath, handleMessage);
    app.listen(port, () => {
        logger.info(`Listening on port ${port}`);
        logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`);
        logger.info(`POST messages: http://localhost:${port}${messagePath}`);
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(line => {
            if (!line.trim())
                return;
            try {
                const jsonMsg = JSON.parse(line);
                logger.info('Stdio Child -> All SSE Clients:', jsonMsg);
                // Send to ALL connected SSE clients
                Object.entries(sessions).forEach(([sid, session]) => {
                    try {
                        if (session.transport) {
                            session.transport.send(jsonMsg);
                        }
                        else {
                            logger.warn(`Session ${sid} has no transport, skipping send.`);
                        }
                    }
                    catch (err) {
                        logger.error(`Failed to send to session ${sid}:`, err);
                        // Clean up potentially dead session
                        if (session.response && !session.response.closed) {
                            try {
                                session.response.end();
                            }
                            catch { }
                        }
                        delete sessions[sid];
                    }
                });
            }
            catch (err) {
                logger.error(`Child non-JSON stdout: ${line}`, err);
            }
        });
    });
    child.stderr.on('data', (chunk) => {
        logger.error(`Child stderr: ${chunk.toString('utf8').trim()}`);
    });
}
async function sseToStdio(args) {
    // ... (sseToStdio implementation remains the same)
    const { sseUrl, logger } = args;
    logger.info('Starting sse-to-stdio mode...');
    logger.info(`  - sse: ${sseUrl}`);
    logger.info('Connecting to SSE...');
    onSignals({ logger }); // Pass empty adapters array or handle differently if needed
    const sseTransport = new SSEClientTransport(new URL(sseUrl));
    const sseClient = new Client({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} });
    sseTransport.onerror = err => {
        logger.error('SSE error:', err);
        process.exit(1); // Exit if remote connection fails
    };
    sseTransport.onclose = () => {
        logger.error('SSE connection closed');
        process.exit(1); // Exit if remote connection closes
    };
    try {
        await sseClient.connect(sseTransport);
        logger.info('SSE connected');
    }
    catch (err) {
        logger.error('Failed to connect to SSE:', err);
        process.exit(1);
    }
    const stdioServer = new Server(sseClient.getServerVersion() ?? { name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: sseClient.getServerCapabilities() ?? {} } // Use capabilities from remote server
    );
    const stdioTransport = new StdioServerTransport();
    // Forward messages from stdio client to the remote SSE server
    stdioTransport.onmessage = async (message) => {
        logger.info('Stdio Client -> Remote SSE:', JSON.stringify(message));
        try {
            // Use the client's request/notification methods for proper handling
            if ('method' in message) {
                if ('id' in message) { // It's a request
                    const req = message;
                    // Don't await here, let the response come back via sseTransport.onmessage
                    sseClient.request(req, z.any())
                        .then(result => {
                        // Construct and send response back to stdio client
                        const response = {
                            jsonrpc: req.jsonrpc || '2.0',
                            id: req.id,
                            result: result, // Assuming SDK handles error wrapping correctly
                        };
                        logger.info('Remote SSE Response -> Stdio Client:', JSON.stringify(response));
                        process.stdout.write(JSON.stringify(response) + '\n');
                    })
                        .catch(err => {
                        logger.error('Error forwarding request to remote SSE:', err);
                        const errorResponse = {
                            jsonrpc: req.jsonrpc || '2.0',
                            id: req.id,
                            error: { code: -32000, message: err.message || 'Failed to process request' }
                        };
                        logger.info('Error Response -> Stdio Client:', JSON.stringify(errorResponse));
                        process.stdout.write(JSON.stringify(errorResponse) + '\n');
                    });
                }
                else { // It's a notification
                    await sseClient.notification(message);
                }
            }
            else {
                logger.error("Received non-request/notification message from stdio, ignoring:", message);
            }
        }
        catch (err) {
            logger.error('Error sending message to remote SSE:', err);
        }
    };
    // Forward messages received from remote SSE server to the stdio client
    sseTransport.onmessage = (message) => {
        logger.info('Remote SSE -> Stdio Client:', JSON.stringify(message));
        // Directly write received messages (responses or notifications from server) to stdout
        process.stdout.write(JSON.stringify(message) + '\n');
    };
    try {
        await stdioServer.connect(stdioTransport); // Connects stdio transport to the server logic
        logger.info('Stdio server transport connected and listening');
    }
    catch (err) {
        logger.error('Failed to connect stdio server transport:', err);
        process.exit(1);
    }
}
async function sseToSse(args) {
    const { ssetosseUrl, port, baseUrl, ssePath, messagePath, logger, enableCors, healthEndpoints, timeout } = args;
    logger.info('Starting sse-to-sse mode...');
    logger.info(`  - Remote SSE: ${ssetosseUrl}`);
    logger.info(`  - port: ${port}`);
    logger.info(`  - baseUrl: ${baseUrl}`);
    logger.info(`  - ssePath: ${ssePath}`);
    logger.info(`  - messagePath: ${messagePath}`);
    logger.info(`  - connection timeout: ${timeout}ms`);
    logger.info(`  - CORS enabled: ${enableCors}`);
    logger.info(`  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`);
    onSignals({ logger }); // Set up signal handlers
    // Connect to the remote SSE server
    const remoteTransport = new SSEClientTransport(new URL(ssetosseUrl));
    const remoteClient = new Client({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} });
    // Set up error handling for the remote connection
    remoteTransport.onerror = err => {
        logger.error('Remote SSE error:', err);
        process.exit(1); // Exit if remote connection fails
    };
    remoteTransport.onclose = () => {
        logger.error('Remote SSE connection closed');
        process.exit(1); // Exit if remote connection closes
    };
    // Try to connect to the remote SSE server
    try {
        await remoteClient.connect(remoteTransport);
        logger.info('Connected to remote SSE server');
    }
    catch (err) {
        logger.error('Failed to connect to remote SSE server:', err);
        process.exit(1);
    }
    // Set up the local SSE server for clients to connect to
    const localServer = new Server(remoteClient.getServerVersion() ?? { name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: remoteClient.getServerCapabilities() ?? {} });
    const sessions = {};
    const app = express();
    if (enableCors) {
        app.use(cors());
    }
    // Use bodyParser.json() only for non-message paths
    app.use((req, res, next) => {
        if (req.path !== messagePath) {
            bodyParser.json()(req, res, next);
        }
        else {
            next(); // Skip body parsing for the raw message endpoint
        }
    });
    // Add health endpoints
    for (const ep of healthEndpoints) {
        app.get(ep, (_req, res) => {
            res.send('ok');
        });
    }
    // Handle SSE connections from clients
    app.get(ssePath, async (req, res) => {
        logger.info(`New SSE connection from ${req.ip}`);
        const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res);
        await localServer.connect(sseTransport);
        const sessionId = sseTransport.sessionId;
        sessions[sessionId] = { transport: sseTransport, response: res };
        // Forward messages from the client to the remote SSE server
        sseTransport.onmessage = (msg) => {
            logger.info(`Client (SSE ${sessionId}) -> Remote SSE: ${JSON.stringify(msg)}`);
            remoteTransport.send(msg).catch(err => {
                logger.error(`Failed to forward message to remote SSE:`, err);
                // Optionally notify the client about the error
            });
        };
        // Clean up when the SSE connection is closed
        sseTransport.onclose = () => {
            logger.info(`SSE connection closed (session ${sessionId})`);
            delete sessions[sessionId];
        };
        sseTransport.onerror = err => {
            logger.error(`SSE error (session ${sessionId}):`, err);
            delete sessions[sessionId];
        };
        req.on('close', () => {
            logger.info(`Client disconnected (session ${sessionId})`);
            delete sessions[sessionId];
        });
    });
    // Handle message POSTs from clients
    const handleMessage = (req, res, next) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            res.status(400).send('Missing sessionId parameter');
            return;
        }
        const session = sessions[sessionId];
        if (session?.transport?.handlePostMessage) {
            logger.info(`POST to SSE transport (session ${sessionId})`);
            session.transport.handlePostMessage(req, res).catch(err => {
                logger.error(`Error handling message from session ${sessionId}:`, err);
                res.status(500).send('Internal server error');
            });
        }
        else {
            logger.error(`No active SSE transport found for session ${sessionId}, replying 503`);
            res.status(503).send(`No active SSE connection for session ${sessionId}`);
        }
    };
    app.post(messagePath, handleMessage);
    // Start the server
    app.listen(port, () => {
        logger.info(`Listening on port ${port}`);
        logger.info(`SSE endpoint: ${baseUrl}${ssePath}`);
        logger.info(`POST messages: ${baseUrl}${messagePath}`);
    });
    // Forward messages from the remote SSE server to all connected clients
    remoteTransport.onmessage = (message) => {
        logger.info('Remote SSE -> All SSE Clients:', JSON.stringify(message));
        // Send to ALL connected SSE clients
        Object.entries(sessions).forEach(([sid, session]) => {
            try {
                if (session.transport) {
                    session.transport.send(message);
                }
                else {
                    logger.error(`Session ${sid} has no transport, skipping send.`);
                }
            }
            catch (err) {
                logger.error(`Failed to send to session ${sid}:`, err);
                // Clean up potentially dead session
                if (session.response && !session.response.closed) {
                    try {
                        session.response.end();
                    }
                    catch { }
                }
                delete sessions[sid];
            }
        });
    };
}
// --- New Function: configToSse ---
async function configToSse(args) {
    const { configPath, port, baseUrl, ssePath, messagePath, logger, enableCors, healthEndpoints,
    // timeout // Timeout might be needed for SSE adapter connections
     } = args;
    logger.info('Starting in multi-server config mode...');
    logger.info(`  - config: ${configPath}`);
    logger.info(`  - port: ${port}`);
    logger.info(`  - baseUrl: ${baseUrl || `http://localhost:${port}`}`); // Default baseUrl if empty
    logger.info(`  - ssePath: ${ssePath}`);
    logger.info(`  - messagePath: ${messagePath}`);
    // logger.info(`  - connection timeout: ${timeout}ms`) // Add if using timeout
    logger.info(`  - CORS enabled: ${enableCors}`);
    logger.info(`  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`);
    // Read and parse config file
    let config;
    try {
        const configContent = readFileSync(configPath, 'utf-8');
        const parsedConfig = JSON.parse(configContent);
        config = ConfigSchema.parse(parsedConfig);
        logger.info(`Loaded ${Object.keys(config.mcpServers).length} server configurations.`);
    }
    catch (err) {
        logger.error(`Failed to read or parse config file ${configPath}:`, err);
        process.exit(1); // Exit if config is invalid
    }
    // Initialize server adapters
    const serverAdapters = [];
    const initializationPromises = [];
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        // Infer type if not explicitly provided
        const type = ('command' in serverConfig && serverConfig.command) ? 'stdio' : ('url' in serverConfig && serverConfig.url) ? 'sse' : null;
        if (serverConfig.disabled) {
            logger.info(`[${serverName}] Skipping disabled server.`);
            continue;
        }
        if (type === 'stdio') {
            logger.info(`[${serverName}] Configuring stdio server...`);
            const adapter = new StdioServerAdapter(serverName, serverConfig, // Cast after type check
            logger);
            serverAdapters.push(adapter);
            initializationPromises.push(adapter.initialize()); // Add initialization promise
        }
        else if (type === 'sse') {
            logger.info(`[${serverName}] Configuring SSE server...`);
            const adapter = new SseServerAdapter(serverName, serverConfig, // Cast after type check
            logger);
            serverAdapters.push(adapter);
            initializationPromises.push(adapter.initialize()); // Add initialization promise
        }
        else {
            logger.error(`[${serverName}] Invalid configuration: missing 'command' or 'url'. Skipping.`);
        }
    }
    // Wait for all non-disabled servers to attempt initialization
    logger.info(`Attempting to initialize ${initializationPromises.length} servers...`);
    const initResults = await Promise.allSettled(initializationPromises);
    const successfulAdapters = serverAdapters.filter((adapter, index) => {
        const result = initResults[index];
        if (result.status === 'rejected') {
            logger.error(`[${adapter.getServerName()}] Failed to initialize:`, result.reason);
            return false; // Filter out failed adapters
        }
        logger.info(`[${adapter.getServerName()}] Initialized successfully.`);
        return !adapter.isDisabled(); // Keep successfully initialized and non-disabled adapters
    });
    if (successfulAdapters.length === 0) {
        logger.error('No backend servers were initialized successfully. Exiting.');
        process.exit(1); // Exit if no servers could start
    }
    logger.info(`Successfully initialized ${successfulAdapters.length} backend servers.`);
    // Setup signal handling *after* adapters might have child processes
    onSignals({ logger, adapters: successfulAdapters });
    // Create the main MCP Server that clients connect to
    // --- Aggregate Capabilities ---
    const aggregatedCapabilities = {
        // Initialize with a base structure, assuming 'tools' is the primary capability key
        tools: []
        // Add other capability fields here if needed, e.g., authenticationMethods: []
    };
    // Map from original tool name to the server(s) that provide it
    const originalToolToServerMap = new Map();
    successfulAdapters.forEach(adapter => {
        const tools = adapter.getFetchedTools();
        const serverName = adapter.getServerName();
        if (tools) {
            logger.info(`[${serverName}] Found ${tools.length} tools via explicit fetch.`);
            // Merge 'tools' array, ensuring uniqueness by name
            if (Array.isArray(tools)) {
                tools.forEach((tool) => {
                    // Simple check for tool name existence
                    if (tool && typeof tool === 'object' && tool.name) {
                        const originalToolName = tool.name; // Original name from the server
                        const prefixedToolName = `${serverName}.${originalToolName}`;
                        // Check uniqueness based on the *prefixed* name
                        if (!aggregatedCapabilities.tools.some((existing) => existing.name === prefixedToolName)) {
                            // Create a new object for the tool to avoid modifying original capabilities object
                            const newTool = { ...tool, name: prefixedToolName };
                            aggregatedCapabilities.tools.push(newTool);
                            logger.info(`[${serverName}] Added tool: ${prefixedToolName}`);
                        }
                        else {
                            logger.warn(`[${serverName}] Aggregated tool '${prefixedToolName}' already exists, skipping duplicate.`);
                        }
                        // Populate the original name map
                        const serversForTool = originalToolToServerMap.get(originalToolName) || [];
                        if (!serversForTool.includes(serverName)) {
                            serversForTool.push(serverName);
                            originalToolToServerMap.set(originalToolName, serversForTool);
                            logger.info(`[Mapping] Mapped original tool '${originalToolName}' to server '${serverName}'.`);
                        }
                    }
                    else {
                        logger.warn(`[${serverName}] Skipping invalid tool entry:`, tool);
                    }
                });
            }
            else {
                // This case should technically not happen if getFetchedTools returns array or null
                logger.warn(`[${serverName}] Fetched tools is not an array, skipping tool aggregation for this server. Found:`, tools);
            }
        }
        else {
            logger.warn(`[${serverName}] Did not successfully fetch tools list during initialization.`);
        }
    });
    logger.info(`Aggregated capabilities for main server:`, JSON.stringify(aggregatedCapabilities));
    logger.info(`Original tool to server map:`, JSON.stringify(Object.fromEntries(originalToolToServerMap))); // Log the map
    // --- End Aggregate Capabilities ---
    // TODO: Implement capability merging in the future
    const mainServer = new Server({ name: 'mcp-superassistant-proxy-aggregator', version: getVersion() }, 
    // { capabilities: {} } // Start with empty capabilities, merging is complex
    aggregatedCapabilities // <-- Use aggregated capabilities
    );
    // Setup express app
    const app = express();
    if (enableCors) {
        app.use(cors());
    }
    // Use bodyParser.json() only for non-message paths
    app.use((req, res, next) => {
        if (req.path !== messagePath) {
            bodyParser.json()(req, res, next);
        }
        else {
            next(); // Skip body parsing for the raw message endpoint
        }
    });
    // Add health endpoints
    for (const ep of healthEndpoints) {
        app.get(ep, (_req, res) => {
            res.send('ok');
        });
    }
    // Store client sessions connected to *this* proxy server
    const clientSessions = {};
    // --- Store mapping for pending requests to route responses back correctly ---
    const pendingRequests = new Map();
    // --- Route messages FROM Backend Servers TO Clients ---
    successfulAdapters.forEach((adapter) => {
        adapter.onMessage((message) => {
            // Message received from a backend server (adapter)
            // Check if this is a response to a pending request
            if ('id' in message && pendingRequests.has(message.id)) {
                // This is a response to a pending request, ensure it's from the right server
                const { clientTransport, serverName } = pendingRequests.get(message.id);
                // Only accept responses from the server we sent the request to
                if (serverName === adapter.getServerName()) {
                    logger.info(`[${adapter.getServerName()}] ↓ Response for request ID ${message.id} routed to specific client`);
                    try {
                        clientTransport.send(message);
                        // Remove the pending request after routing the response
                        pendingRequests.delete(message.id);
                    }
                    catch (err) {
                        logger.error(`Failed to send response from ${adapter.getServerName()} for request ID ${message.id}:`, err);
                        pendingRequests.delete(message.id);
                    }
                }
                else {
                    logger.warn(`[${adapter.getServerName()}] Received response for request ID ${message.id} but expected from ${serverName}, ignoring`);
                }
            }
            else {
                // For non-response messages (notifications, etc.), broadcast to all clients
                logger.info(`[${adapter.getServerName()}] ↓ Broadcasting to ${Object.keys(clientSessions).length} clients: ${JSON.stringify(message)}`);
                Object.entries(clientSessions).forEach(([clientId, session]) => {
                    try {
                        if (session.transport) {
                            session.transport.send(message);
                        }
                        else {
                            logger.error(`Client session ${clientId} has no transport, skipping send.`);
                        }
                    }
                    catch (err) {
                        logger.error(`Failed to send message from ${adapter.getServerName()} to client ${clientId}:`, err);
                        // Clean up potentially dead client session
                        if (session.response && !session.response.closed) {
                            try {
                                session.response.end();
                            }
                            catch { }
                        }
                        delete clientSessions[clientId];
                    }
                });
            }
        });
    });
    // Setup SSE endpoint for clients connecting TO the proxy
    app.get(ssePath, async (req, res) => {
        const clientId = req.ip + "_" + Date.now(); // Simple client identifier
        logger.info(`[Proxy] New client connection (${clientId}) from ${req.ip}`);
        // Each client gets its own transport connected to the mainServer logic
        const clientTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res);
        await mainServer.connect(clientTransport); // Connects mainServer logic to this specific client
        const sessionId = clientTransport.sessionId; // Get the unique ID for this connection
        clientSessions[sessionId] = { transport: clientTransport, response: res };
        logger.info(`[Proxy] Client session ${sessionId} established.`);
        // --- Route messages FROM Client TO Backend Servers ---
        clientTransport.onmessage = (msg) => {
            // --- Intercept tools/list --- 
            if ('method' in msg && msg.method === 'tools/list' && 'id' in msg) {
                logger.info(`[Client ${sessionId}] Intercepting tools/list request.`);
                const response = {
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { tools: aggregatedCapabilities.tools } // Respond with aggregated, prefixed tools
                };
                try {
                    clientTransport.send(response);
                    logger.info(`[Client ${sessionId}] Sent aggregated tool list response.`);
                }
                catch (err) {
                    logger.error(`[Client ${sessionId}] Error sending aggregated tool list response:`, err);
                    // Consider closing the transport or session
                }
                return; // Stop processing this message further (don't forward)
            }
            // --- End Intercept tools/list ---
            // --- Intercept tools/call --- 
            if ('method' in msg && msg.method === 'tools/call' && 'id' in msg && msg.params?.name) {
                const prefixedName = msg.params.name;
                const dotIndex = prefixedName.indexOf('.');
                if (dotIndex > 0) {
                    const serverName = prefixedName.substring(0, dotIndex);
                    const originalToolName = prefixedName.substring(dotIndex + 1);
                    logger.info(`[Client ${sessionId}] Intercepting tools/call for ${prefixedName}. Target: ${serverName}, Original Tool: ${originalToolName}`);
                    const targetAdapter = successfulAdapters.find(a => a.getServerName() === serverName);
                    if (targetAdapter && !targetAdapter.isDisabled()) {
                        // Modify the request to use the original tool name
                        const modifiedRequest = {
                            ...msg, // Copy other fields like jsonrpc, id
                            params: {
                                ...(msg.params || {}),
                                name: originalToolName, // Use original name
                            }
                        };
                        // Store mapping to route response back
                        pendingRequests.set(msg.id, { clientTransport, serverName });
                        logger.info(`[Proxy] Stored pending request mapping for ID ${msg.id}`);
                        // Send *only* to the target adapter
                        try {
                            targetAdapter.send(modifiedRequest);
                            logger.info(`[Proxy] → Forwarded modified tools/call ID ${msg.id} to [${targetAdapter.getServerName()}]`);
                        }
                        catch (sendErr) {
                            logger.error(`[Proxy] Error sending modified tools/call ID ${msg.id} to [${targetAdapter.getServerName()}]:`, sendErr);
                            // Remove mapping
                            pendingRequests.delete(msg.id);
                            // Send error response back to client
                            const errorResponse = {
                                jsonrpc: '2.0',
                                id: msg.id,
                                error: {
                                    code: -32603,
                                    message: `Internal error: Failed to send request to target server [${targetAdapter.getServerName()}]`,
                                    data: { originalError: sendErr instanceof Error ? sendErr.message : String(sendErr) }
                                }
                            };
                            try {
                                clientTransport.send(errorResponse);
                                logger.info(`[Proxy] Sent error response for ID ${msg.id} back to client`);
                            }
                            catch (responseErr) {
                                logger.error(`[Proxy] Error sending error response for ID ${msg.id} back to client:`, responseErr);
                            }
                        }
                        return; // CRITICAL: Stop processing this message further
                    }
                    else {
                        logger.error(`[Client ${sessionId}] Target server '${serverName}' for tool '${prefixedName}' not found, disabled, or failed initialization.`);
                        // Send error response back to client
                        const errorResponse = {
                            jsonrpc: '2.0',
                            id: msg.id,
                            error: {
                                code: -32601,
                                message: `Target server '${serverName}' for tool '${prefixedName}' is not available.`,
                                data: { availableServers: successfulAdapters.map(a => a.getServerName()) }
                            }
                        };
                        try {
                            clientTransport.send(errorResponse);
                            logger.info(`[Proxy] Sent error response for missing server [${serverName}] back to client`);
                        }
                        catch (err) {
                            logger.error(`[Proxy] Error sending error response to client ${sessionId}:`, err);
                        }
                        return; // CRITICAL: Stop processing this message further
                    }
                }
                else {
                    // --- Handle Unprefixed tools/call --- 
                    const originalToolName = prefixedName; // Here, prefixedName is actually the original name
                    logger.info(`[Client ${sessionId}] Received tools/call with unprefixed name: ${originalToolName}. Looking up target server...`);
                    const targetServers = originalToolToServerMap.get(originalToolName);
                    if (targetServers && targetServers.length === 1) {
                        const serverName = targetServers[0];
                        const targetAdapter = successfulAdapters.find(a => a.getServerName() === serverName);
                        if (targetAdapter && !targetAdapter.isDisabled()) {
                            // Request already has the original tool name, no modification needed
                            const requestToForward = msg;
                            // Store mapping to route response back
                            pendingRequests.set(msg.id, { clientTransport, serverName });
                            logger.info(`[Proxy] Stored pending request mapping for ID ${msg.id}`);
                            // Send *only* to the target adapter
                            try {
                                targetAdapter.send(requestToForward);
                                logger.info(`[Proxy] → Forwarded unprefixed tools/call ID ${msg.id} ('${originalToolName}') to [${targetAdapter.getServerName()}]`);
                            }
                            catch (sendErr) {
                                logger.error(`[Proxy] Error sending unprefixed tools/call ID ${msg.id} to [${targetAdapter.getServerName()}]:`, sendErr);
                                pendingRequests.delete(msg.id);
                                // Send error response back to client
                                const errorResponse = {
                                    jsonrpc: '2.0',
                                    id: msg.id,
                                    error: {
                                        code: -32603,
                                        message: `Internal error: Failed to send request to target server [${targetAdapter.getServerName()}]`,
                                        data: { originalError: sendErr instanceof Error ? sendErr.message : String(sendErr) }
                                    }
                                };
                                try {
                                    clientTransport.send(errorResponse);
                                    logger.info(`[Proxy] Sent error response for ID ${msg.id} back to client`);
                                }
                                catch (responseErr) {
                                    logger.error(`[Proxy] Error sending error response for ID ${msg.id} back to client:`, responseErr);
                                }
                            }
                            return; // CRITICAL: Stop processing this message further
                        }
                        else {
                            // This case should be rare if map is accurate, but handle it
                            logger.error(`[Client ${sessionId}] Mapped server '${serverName}' for tool '${originalToolName}' not found, disabled, or failed init.`);
                            const errorResponse = {
                                jsonrpc: '2.0',
                                id: msg.id,
                                error: {
                                    code: -32601,
                                    message: `Mapped server '${serverName}' for tool '${originalToolName}' is not available.`,
                                    data: { availableServers: successfulAdapters.map(a => a.getServerName()) }
                                }
                            };
                            try {
                                clientTransport.send(errorResponse);
                                logger.info(`[Proxy] Sent error response for missing mapped server [${serverName}] back to client`);
                            }
                            catch (err) {
                                logger.error(`[Proxy] Error sending error response to client ${sessionId}:`, err);
                            }
                            return; // CRITICAL: Stop processing this message further
                        }
                    }
                    else if (targetServers && targetServers.length > 1) {
                        // Tool name is ambiguous (exists on multiple servers)
                        logger.error(`[Client ${sessionId}] Unprefixed tool '${originalToolName}' is ambiguous, exists on servers: ${targetServers.join(', ')}`);
                        const errorResponse = {
                            jsonrpc: '2.0',
                            id: msg.id,
                            error: {
                                code: -32601,
                                message: `Tool '${originalToolName}' is ambiguous. Please use prefix: ${targetServers.map(s => `${s}.${originalToolName}`).join(' or ')}`,
                                data: { availableServers: targetServers }
                            }
                        };
                        try {
                            clientTransport.send(errorResponse);
                            logger.info(`[Proxy] Sent ambiguous tool error response back to client`);
                        }
                        catch (err) {
                            logger.error(`[Proxy] Error sending error response to client ${sessionId}:`, err);
                        }
                    }
                    else {
                        // Tool not found in the map
                        logger.error(`[Client ${sessionId}] Unprefixed tool '${originalToolName}' not found on any available server.`);
                        const errorResponse = {
                            jsonrpc: '2.0',
                            id: msg.id,
                            error: {
                                code: -32601,
                                message: `Tool '${originalToolName}' not found.`,
                                data: {
                                    availableTools: Array.from(originalToolToServerMap.keys()),
                                    availableServers: successfulAdapters.map(a => a.getServerName())
                                }
                            }
                        };
                        try {
                            clientTransport.send(errorResponse);
                            logger.info(`[Proxy] Sent tool not found error response back to client`);
                        }
                        catch (err) {
                            logger.error(`[Proxy] Error sending error response to client ${sessionId}:`, err);
                        }
                    }
                    return; // Stop processing this message further
                    // --- End Handle Unprefixed tools/call --- 
                }
            }
            // --- End Intercept tools/call ---
            // --- Fallback/Notification Broadcast --- 
            // Only reaches here for messages that are NOT tools/call (e.g., notifications)
            // or if tools/call logic explicitly falls through (which it shouldn't anymore)
            logger.info(`[Client ${sessionId}] ↑ Broadcasting non-tool-call or fallback message to ${successfulAdapters.length} backends: ${JSON.stringify(msg)}`);
            successfulAdapters.forEach(adapter => {
                // Use individual try-catch for each adapter during broadcast
                try {
                    if (!adapter.isDisabled()) { // Double-check adapter isn't disabled
                        adapter.send(msg);
                    }
                    else {
                        // Optional: Log that we are skipping a disabled adapter during broadcast
                        // logger.info(`[Proxy] Skipping broadcast to disabled adapter: ${adapter.getServerName()}`);
                    }
                }
                catch (broadcastErr) {
                    logger.error(`[Proxy] Error broadcasting message ID ${('id' in msg) ? msg.id : '(notification)'} to [${adapter.getServerName()}]:`, broadcastErr);
                    // Continue to next adapter
                }
            });
        };
        clientTransport.onclose = () => {
            logger.info(`[Proxy] Client session ${sessionId} closed.`);
            delete clientSessions[sessionId];
        };
        clientTransport.onerror = err => {
            logger.error(`[Proxy] Client session ${sessionId} error:`, err);
            delete clientSessions[sessionId]; // Clean up on error
        };
        req.on('close', () => {
            // This might be redundant with transport.onclose but good for safety
            if (clientSessions[sessionId]) {
                logger.info(`[Proxy] Client session ${sessionId} disconnected (request closed).`);
                delete clientSessions[sessionId];
            }
        });
    });
    // Setup message POST endpoint for clients sending messages
    const handleClientMessage = (req, res, next) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            logger.error("[Proxy] Received POST message without sessionId.");
            res.status(400).send('Missing sessionId parameter');
            return;
        }
        const session = clientSessions[sessionId];
        if (session?.transport?.handlePostMessage) {
            // logger.info(`[Proxy] POST received for session ${sessionId}`);
            // handlePostMessage will parse the body and trigger the onmessage handler above
            session.transport.handlePostMessage(req, res).catch(err => {
                logger.error(`Error handling message from session ${sessionId}:`, err);
                res.status(500).send('Internal server error');
            });
        }
        else {
            logger.error(`[Proxy] No active transport for POST session ${sessionId}, replying 503.`);
            res.status(503).send(`No active SSE connection for session ${sessionId}`);
        }
    };
    app.post(messagePath, handleClientMessage);
    // Start listening
    app.listen(port, () => {
        logger.info(`Multi-server proxy listening on port ${port}`);
        logger.info(`SSE endpoint: ${baseUrl}${ssePath}`);
        logger.info(`POST messages: ${baseUrl}${messagePath}`);
        logger.info(`Proxying for: ${successfulAdapters.map(a => a.getServerName()).join(', ')}`);
    });
}
// --- End configToSse ---
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('stdio', {
        type: 'string',
        description: 'Command to run an MCP server over Stdio (stdio -> SSE mode)'
    })
        .option('sse', {
        type: 'string',
        description: 'SSE URL to connect to (SSE -> stdio mode)'
    })
        .option('ssetosse', {
        type: 'string',
        description: 'Remote SSE URL to proxy to (SSE -> SSE mode)'
    })
        .option('config', {
        alias: 'c',
        type: 'string',
        description: 'Path to JSON config file for multiple servers (config -> SSE mode)'
    })
        .option('port', {
        type: 'number',
        default: 3007,
        description: 'Port for the proxy server to listen on (stdio->SSE, sse->sse, config->SSE modes)'
    })
        .option('baseUrl', {
        type: 'string',
        // default: '', // Default handled in specific modes if needed
        description: 'Base URL prefix for SSE message endpoints (stdio->SSE, sse->sse, config->SSE modes)'
    })
        .option('ssePath', {
        type: 'string',
        default: '/sse',
        description: 'Path for SSE subscription endpoint (stdio->SSE, sse->sse, config->SSE modes)'
    })
        .option('messagePath', {
        type: 'string',
        default: '/message',
        description: 'Path for SSE POST message endpoint (stdio->SSE, sse->sse, config->SSE modes)'
    })
        .option('logLevel', {
        choices: ['info', 'none'],
        default: 'info',
        description: 'Set logging level'
    })
        .option('cors', {
        type: 'boolean',
        default: true,
        description: 'Enable CORS for the proxy server'
    })
        .option('healthEndpoint', {
        type: 'array',
        default: [],
        string: true, // Ensure endpoints are treated as strings
        description: 'One or more health check endpoints returning "ok" (e.g., /healthz)'
    })
        .option('timeout', {
        type: 'number',
        default: 30000,
        description: 'Connection timeout in milliseconds (sse->sse, config->SSE modes for SSE backends)'
    })
        .help()
        // Add check for mutually exclusive modes
        .check((argv) => {
        const modes = [argv.stdio, argv.sse, argv.ssetosse, argv.config].filter(Boolean).length;
        if (modes !== 1) {
            throw new Error('Error: Specify exactly one of --stdio, --sse, --ssetosse, or --config');
        }
        return true; // Indicate success
    })
        .parseSync(); // Use parseSync for immediate validation
    const logger = argv.logLevel === 'none'
        ? noneLogger
        : { info: log, error: logStderr, warn: logStderr };
    // Determine default baseUrl if not provided
    const defaultBaseUrl = `http://localhost:${argv.port}`;
    const baseUrl = argv.baseUrl || defaultBaseUrl;
    try {
        if (argv.stdio) {
            await stdioToSse({
                stdioCmd: argv.stdio,
                port: argv.port,
                baseUrl: baseUrl, // Use calculated baseUrl
                ssePath: argv.ssePath,
                messagePath: argv.messagePath,
                logger: logger,
                enableCors: argv.cors,
                healthEndpoints: argv.healthEndpoint
            });
        }
        else if (argv.sse) {
            await sseToStdio({
                sseUrl: argv.sse,
                logger: logger // Use stderr for sse->stdio as it's often a command line tool
            });
        }
        else if (argv.ssetosse) {
            // sseToSse needs adaptation if it requires adapters or different signal handling
            await sseToSse({
                ssetosseUrl: argv.ssetosse,
                port: argv.port,
                baseUrl: baseUrl, // Use calculated baseUrl
                ssePath: argv.ssePath,
                messagePath: argv.messagePath,
                logger: logger,
                enableCors: argv.cors,
                healthEndpoints: argv.healthEndpoint,
                timeout: argv.timeout
            });
        }
        else if (argv.config) { // Handle config mode
            await configToSse({
                configPath: argv.config,
                port: argv.port,
                baseUrl: baseUrl, // Use calculated baseUrl
                ssePath: argv.ssePath,
                messagePath: argv.messagePath,
                logger: logger,
                enableCors: argv.cors,
                healthEndpoints: argv.healthEndpoint,
                timeout: argv.timeout
            });
        }
    }
    catch (err) {
        logger.error('Fatal error during execution:', err);
        process.exit(1);
    }
}
main();
