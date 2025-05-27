#!/usr/bin/env node
/**
 * index.ts
 *
 * Run a proxy server that connects to multiple MCP servers and exposes them through a single SSE endpoint.
 *
 * Usage:
 *   npx -y @srbhptl39/mcp-superassistant-proxy --config path/to/config.json
 */
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { spawn } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListToolsResultSchema, ListPromptsResultSchema, ListResourcesResultSchema, ReadResourceResultSchema, ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema, CompatibilityCallToolResultSchema, GetPromptResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { join, dirname, isAbsolute } from 'path';
import { readFileSync } from 'fs';
import * as eventsource from 'eventsource';
// Required for SSE client in Node
global.EventSource = eventsource.EventSource;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function getVersion() {
    try {
        const packageJsonPath = join(__dirname, '../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        return packageJson.version || '1.0.0';
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
    debug: () => { }
};
const debugLogger = {
    info: (...args) => console.log('[mcp-superassistant-proxy]', ...args),
    error: (...args) => console.error('[mcp-superassistant-proxy]', ...args),
    debug: (...args) => console.debug('[mcp-superassistant-proxy][DEBUG]', ...args)
};
const infoLogger = {
    info: (...args) => console.log('[mcp-superassistant-proxy]', ...args),
    error: (...args) => console.error('[mcp-superassistant-proxy]', ...args),
    debug: () => { }
};
// ----- Server & Client Functions -----
const createStdioClient = async (name, config, logger) => {
    logger.debug(`Starting command server "${name}": ${config.command} ${config.args?.join(' ') || ''}`);
    // Prepare environment variables
    const env = { ...process.env };
    if (config.env) {
        Object.entries(config.env).forEach(([key, value]) => {
            env[key] = value;
        });
    }
    // Start child process
    const child = spawn(config.command, config.args || [], {
        shell: true,
        env
    });
    // Set up event handlers
    child.on('exit', (code, signal) => {
        logger.error(`Child process "${name}" exited: code=${code}, signal=${signal}`);
    });
    // Create MCP client
    const client = new Client({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} });
    // Use the built-in StdioServerTransport instead of custom implementation
    // This ensures proper type compatibility
    const stdioTransport = new StdioServerTransport();
    // Connect the transport to the child process
    let buffer = '';
    // Handle input from child process
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(line => {
            if (!line.trim())
                return;
            try {
                const jsonMsg = JSON.parse(line);
                logger.debug(`"${name}" (stdio) → Proxy:`, jsonMsg);
                if (stdioTransport.onmessage) {
                    stdioTransport.onmessage(jsonMsg);
                }
            }
            catch (err) {
                logger.error(`Child "${name}" non-JSON output: ${line}`);
            }
        });
    });
    // Override send method to write to child stdin
    const originalSend = stdioTransport.send;
    stdioTransport.send = (message) => {
        logger.debug(`Proxy → "${name}" (stdio):`, message);
        child.stdin.write(JSON.stringify(message) + '\n');
        return originalSend.call(stdioTransport, message);
    };
    // Connect the client
    await client.connect(stdioTransport);
    logger.debug(`Connected to "${name}" stdio server`);
    return {
        name,
        client,
        cleanup: async () => {
            try {
                child.kill();
            }
            catch (err) {
                logger.error(`Error cleaning up stdio client "${name}":`, err);
            }
        },
        type: 'stdio'
    };
};
const createSSEClient = async (name, config, logger, timeout = 30000) => {
    logger.debug(`Connecting to SSE server "${name}": ${config.url}`);
    try {
        // Create SSE transport
        const sseTransport = new SSEClientTransport(new URL(config.url));
        // Set up error handling first
        sseTransport.onerror = err => {
            logger.error(`SSE error from "${name}":`, err);
        };
        sseTransport.onclose = () => {
            logger.error(`SSE connection to "${name}" closed`);
        };
        // Create MCP client
        const client = new Client({ name: 'mcp-superassistant-proxy', version: getVersion() }, { capabilities: {} });
        // Connect with timeout
        let connectionTimeoutId = null;
        try {
            // Set up a timeout for the connection attempt
            const connectWithTimeout = async () => {
                return new Promise((resolve, reject) => {
                    connectionTimeoutId = setTimeout(() => {
                        reject(new Error(`Connection to "${name}" timed out after ${timeout}ms`));
                    }, timeout);
                    // Immediately attempt to connect
                    client.connect(sseTransport)
                        .then(() => {
                        if (connectionTimeoutId)
                            clearTimeout(connectionTimeoutId);
                        logger.debug(`Initially connected to "${name}" SSE server, waiting for ready state`);
                        // Allow a brief moment for the connection to fully establish
                        setTimeout(() => {
                            resolve();
                        }, 500);
                    })
                        .catch(err => {
                        if (connectionTimeoutId)
                            clearTimeout(connectionTimeoutId);
                        reject(err);
                    });
                });
            };
            await connectWithTimeout();
            logger.debug(`Connected to "${name}" SSE server`);
            return {
                name,
                client,
                cleanup: async () => {
                    try {
                        sseTransport.close();
                    }
                    catch (err) {
                        logger.error(`Error cleaning up SSE client "${name}":`, err);
                    }
                },
                type: 'sse'
            };
        }
        catch (err) {
            // Clean up if connection fails
            if (connectionTimeoutId)
                clearTimeout(connectionTimeoutId);
            try {
                sseTransport.close();
            }
            catch (closeErr) {
                // Ignore close errors
            }
            throw err;
        }
    }
    catch (err) {
        logger.error(`Failed to create SSE client for "${name}":`, err);
        throw err;
    }
};
const createClients = async (serverConfigs, logger, timeout = 30000) => {
    const clients = [];
    const errors = [];
    const connectionPromises = Object.entries(serverConfigs).map(async ([name, config]) => {
        try {
            logger.debug(`Attempting to connect to server "${name}"`);
            if ('url' in config) {
                // SSE server
                try {
                    const client = await createSSEClient(name, config, logger, timeout);
                    clients.push(client);
                    return { success: true, name };
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to connect to SSE server "${name}": ${message}`);
                    return { success: false, name };
                }
            }
            else if ('command' in config) {
                // Stdio server
                try {
                    const client = await createStdioClient(name, config, logger);
                    clients.push(client);
                    return { success: true, name };
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to connect to stdio server "${name}": ${message}`);
                    return { success: false, name };
                }
            }
            else {
                errors.push(`Invalid server configuration for "${name}"`);
                return { success: false, name };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`Unexpected error connecting to "${name}": ${message}`);
            return { success: false, name };
        }
    });
    // Wait for all connections (successful or not)
    const results = await Promise.all(connectionPromises);
    // Log connection results
    const successful = results.filter(r => r.success).map(r => r.name);
    const failed = results.filter(r => !r.success).map(r => r.name);
    logger.debug(`Successfully connected to servers: ${successful.join(', ') || '(none)'}`);
    if (failed.length > 0) {
        logger.error(`Failed to connect to servers: ${failed.join(', ')}`);
        errors.forEach(error => logger.error(`  - ${error}`));
    }
    if (clients.length === 0) {
        logger.error('No MCP servers could be connected. The proxy will start but will not be functional.');
    }
    return clients;
};
// Add helper to check if a method is likely supported by a client
const isMcpMethodLikelySupported = (client, method) => {
    // Extract the capability category from the method (e.g., "tools" from "tools/list")
    const category = method.split('/')[0];
    // Get the server capabilities
    const capabilities = client.client.getServerCapabilities() || {};
    // Check if the category is supported in capabilities
    return Boolean(capabilities[category]);
};
// Add helper to handle method not found errors gracefully
const handleMcpMethodNotFound = (err, name, method, logger) => {
    // Extract error code and check if it's "Method not found"
    if (err &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === -32601) {
        // This is a "Method not found" error - expected if server doesn't support this method
        logger.info(`Server "${name}" doesn't support method "${method}" (this is normal)`);
        return true;
    }
    return false;
};
async function startProxyServer({ config, logger }) {
    const { port = 3006, baseUrl = `http://localhost:${port}`, ssePath = '/sse', messagePath = '/message', cors: enableCors = true, healthEndpoints = [], timeout = 30000, mcpServers } = config;
    // Add heartbeat interval configuration (default: 30 seconds)
    const heartbeatInterval = config.heartbeatInterval || 30000;
    logger.info('Starting proxy server...');
    logger.info(`  - port: ${port}`);
    logger.info(`  - baseUrl: ${baseUrl}`);
    logger.info(`  - ssePath: ${ssePath}`);
    logger.info(`  - messagePath: ${messagePath}`);
    logger.info(`  - heartbeat interval: ${heartbeatInterval}ms`);
    logger.info(`  - Connected servers: ${Object.keys(mcpServers).join(', ')}`);
    // Handle termination signals
    process.on('SIGINT', () => {
        logger.info('Caught SIGINT. Exiting...');
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        logger.info('Caught SIGTERM. Exiting...');
        process.exit(0);
    });
    // Connect to all configured servers
    logger.debug(`Attempting to connect to ${Object.keys(mcpServers).length} configured servers...`);
    const connectedClients = await createClients(mcpServers, logger, timeout);
    logger.info(`Connected to ${connectedClients.length} of ${Object.keys(mcpServers).length} servers`);
    // Reference maps to track which client owns which resource
    const toolToClientMap = new Map();
    const resourceToClientMap = new Map();
    const promptToClientMap = new Map();
    // Create the proxy server
    const server = new Server({ name: 'mcp-superassistant-proxy', version: getVersion() }, {
        capabilities: {
            prompts: {},
            resources: { subscribe: true },
            tools: {},
        },
    });
    // ----- Request Handlers -----
    // List Tools Handler
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const allTools = [];
        toolToClientMap.clear();
        for (const connectedClient of connectedClients) {
            // Check if this client likely supports tools
            if (!isMcpMethodLikelySupported(connectedClient, 'tools/list')) {
                logger.debug(`Skipping tools/list for "${connectedClient.name}" (capability not advertised)`);
                continue;
            }
            try {
                const result = await connectedClient.client.request({
                    method: 'tools/list',
                    params: {
                        _meta: request.params?._meta
                    }
                }, ListToolsResultSchema);
                if (result.tools) {
                    const toolsWithSource = result.tools.map(tool => {
                        const originalName = tool.name;
                        const prefixedName = `${connectedClient.name}.${originalName}`;
                        // Store both prefixed and original name in the map for backward compatibility
                        toolToClientMap.set(prefixedName, {
                            client: connectedClient,
                            originalName
                        });
                        toolToClientMap.set(originalName, {
                            client: connectedClient,
                            originalName
                        });
                        return {
                            ...tool,
                            name: prefixedName,
                            description: `[${connectedClient.name}] ${tool.description || ''}`
                        };
                    });
                    allTools.push(...toolsWithSource);
                }
            }
            catch (error) {
                // Handle method not found gracefully
                if (!handleMcpMethodNotFound(error, connectedClient.name, 'tools/list', logger)) {
                    // Only log as error if it's an unexpected error
                    logger.error(`Error fetching tools from ${connectedClient.name}:`, error);
                }
            }
        }
        return { tools: allTools };
    });
    // Call Tool Handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const toolMapping = toolToClientMap.get(name);
        if (!toolMapping) {
            throw new Error(`Unknown tool: ${name}`);
        }
        const { client: clientForTool, originalName } = toolMapping;
        try {
            logger.debug(`Forwarding tool call to "${clientForTool.name}": ${originalName}`);
            return await clientForTool.client.request({
                method: 'tools/call',
                params: {
                    name: originalName, // Use the original tool name when calling the backend
                    arguments: args || {},
                    _meta: {
                        progressToken: request.params._meta?.progressToken
                    }
                }
            }, CompatibilityCallToolResultSchema);
        }
        catch (error) {
            logger.error(`Error calling tool through ${clientForTool.name}:`, error);
            throw error;
        }
    });
    // List Prompts Handler
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        const allPrompts = [];
        promptToClientMap.clear();
        for (const connectedClient of connectedClients) {
            // Check if this client likely supports prompts
            if (!isMcpMethodLikelySupported(connectedClient, 'prompts/list')) {
                logger.debug(`Skipping prompts/list for "${connectedClient.name}" (capability not advertised)`);
                continue;
            }
            try {
                const result = await connectedClient.client.request({
                    method: 'prompts/list',
                    params: {
                        cursor: request.params?.cursor,
                        _meta: request.params?._meta || {
                            progressToken: undefined
                        }
                    }
                }, ListPromptsResultSchema);
                if (result.prompts) {
                    const promptsWithSource = result.prompts.map(prompt => {
                        promptToClientMap.set(prompt.name, connectedClient);
                        return {
                            ...prompt,
                            description: `[${connectedClient.name}] ${prompt.description || ''}`
                        };
                    });
                    allPrompts.push(...promptsWithSource);
                }
            }
            catch (error) {
                // Handle method not found gracefully
                if (!handleMcpMethodNotFound(error, connectedClient.name, 'prompts/list', logger)) {
                    // Only log as error if it's an unexpected error
                    logger.error(`Error fetching prompts from ${connectedClient.name}:`, error);
                }
            }
        }
        return {
            prompts: allPrompts,
            nextCursor: request.params?.cursor
        };
    });
    // Get Prompt Handler
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const { name } = request.params;
        const clientForPrompt = promptToClientMap.get(name);
        if (!clientForPrompt) {
            throw new Error(`Unknown prompt: ${name}`);
        }
        try {
            logger.debug(`Forwarding prompt request to "${clientForPrompt.name}": ${name}`);
            const response = await clientForPrompt.client.request({
                method: 'prompts/get',
                params: {
                    name,
                    arguments: request.params.arguments || {},
                    _meta: request.params._meta || {
                        progressToken: undefined
                    }
                }
            }, GetPromptResultSchema);
            return response;
        }
        catch (error) {
            logger.error(`Error getting prompt from ${clientForPrompt.name}:`, error);
            throw error;
        }
    });
    // List Resources Handler
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        const allResources = [];
        resourceToClientMap.clear();
        for (const connectedClient of connectedClients) {
            // Check if this client likely supports resources
            if (!isMcpMethodLikelySupported(connectedClient, 'resources/list')) {
                logger.debug(`Skipping resources/list for "${connectedClient.name}" (capability not advertised)`);
                continue;
            }
            try {
                const result = await connectedClient.client.request({
                    method: 'resources/list',
                    params: {
                        cursor: request.params?.cursor,
                        _meta: request.params?._meta
                    }
                }, ListResourcesResultSchema);
                if (result.resources) {
                    const resourcesWithSource = result.resources.map(resource => {
                        resourceToClientMap.set(resource.uri, connectedClient);
                        return {
                            ...resource,
                            name: `[${connectedClient.name}] ${resource.name || ''}`
                        };
                    });
                    allResources.push(...resourcesWithSource);
                }
            }
            catch (error) {
                // Handle method not found gracefully
                if (!handleMcpMethodNotFound(error, connectedClient.name, 'resources/list', logger)) {
                    // Only log as error if it's an unexpected error
                    logger.error(`Error fetching resources from ${connectedClient.name}:`, error);
                }
            }
        }
        return {
            resources: allResources,
            nextCursor: undefined
        };
    });
    // Read Resource Handler
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        const clientForResource = resourceToClientMap.get(uri);
        if (!clientForResource) {
            throw new Error(`Unknown resource: ${uri}`);
        }
        try {
            return await clientForResource.client.request({
                method: 'resources/read',
                params: {
                    uri,
                    _meta: request.params._meta
                }
            }, ReadResourceResultSchema);
        }
        catch (error) {
            logger.error(`Error reading resource from ${clientForResource.name}:`, error);
            throw error;
        }
    });
    // List Resource Templates Handler
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
        const allTemplates = [];
        for (const connectedClient of connectedClients) {
            // Check if this client likely supports resource templates
            if (!isMcpMethodLikelySupported(connectedClient, 'resources/templates/list')) {
                logger.debug(`Skipping resources/templates/list for "${connectedClient.name}" (capability not advertised)`);
                continue;
            }
            try {
                const result = await connectedClient.client.request({
                    method: 'resources/templates/list',
                    params: {
                        cursor: request.params?.cursor,
                        _meta: request.params?._meta || {
                            progressToken: undefined
                        }
                    }
                }, ListResourceTemplatesResultSchema);
                if (result.resourceTemplates) {
                    const templatesWithSource = result.resourceTemplates.map(template => ({
                        ...template,
                        name: `[${connectedClient.name}] ${template.name || ''}`,
                        description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
                    }));
                    allTemplates.push(...templatesWithSource);
                }
            }
            catch (error) {
                // Handle method not found gracefully
                if (!handleMcpMethodNotFound(error, connectedClient.name, 'resources/templates/list', logger)) {
                    // Only log as error if it's an unexpected error
                    logger.error(`Error fetching resource templates from ${connectedClient.name}:`, error);
                }
            }
        }
        return {
            resourceTemplates: allTemplates,
            nextCursor: request.params?.cursor
        };
    });
    // ----- Express Server Setup -----
    const app = express();
    const sessions = {};
    // Add a monitoring interval for active connections
    const monitorConnections = () => {
        const now = Date.now();
        // Check each session's last activity time
        Object.entries(sessions).forEach(([id, session]) => {
            const inactiveTime = now - session.lastActivity;
            // Log long inactive periods but don't disconnect (heartbeat should prevent timeout)
            if (inactiveTime > heartbeatInterval * 2) {
                logger.debug(`Session ${id} has been inactive for ${Math.round(inactiveTime / 1000)}s`);
            }
        });
    };
    // Set up connection monitoring - run every minute
    const monitorInterval = setInterval(monitorConnections, 60000);
    // Ensure clean shutdown of intervals
    const cleanup = async () => {
        logger.info('Cleaning up connections...');
        // Clear monitoring interval
        clearInterval(monitorInterval);
        // Clear all session heartbeats
        Object.values(sessions).forEach(session => {
            if (session.heartbeatTimer) {
                clearInterval(session.heartbeatTimer);
            }
        });
        // Clean up client connections
        await Promise.all(connectedClients.map(client => client.cleanup()));
    };
    // Handle termination signals
    process.on('SIGINT', async () => {
        logger.info('Caught SIGINT. Cleaning up and exiting...');
        await cleanup();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        logger.info('Caught SIGTERM. Cleaning up and exiting...');
        await cleanup();
        process.exit(0);
    });
    if (enableCors) {
        app.use(cors());
    }
    app.use((req, res, next) => {
        if (req.path === messagePath) {
            next();
        }
        else {
            bodyParser.json()(req, res, next);
        }
    });
    // Health endpoints
    for (const ep of healthEndpoints) {
        app.get(ep, (_req, res) => {
            res.send('ok');
        });
    }
    const asyncHandler = (fn) => {
        return (req, res, next) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    };
    // SSE endpoint with heartbeat support
    app.get(ssePath, asyncHandler(async (req, res) => {
        logger.info(`New SSE connection from ${req.ip}`);
        // Set headers for better reliability
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in Nginx
        // Create SSE transport
        const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res);
        await server.connect(sseTransport);
        const sessionId = sseTransport.sessionId;
        if (sessionId) {
            // Track last activity time
            const sessionData = {
                transport: sseTransport,
                response: res,
                lastActivity: Date.now(),
                heartbeatTimer: undefined
            };
            // Setup heartbeat for this session
            const heartbeat = () => {
                try {
                    // Send a comment as heartbeat (won't be parsed as an event by clients)
                    res.write(': heartbeat\n\n');
                    sessionData.lastActivity = Date.now();
                }
                catch (err) {
                    logger.error(`Error sending heartbeat to session ${sessionId}:`, err);
                    // If we can't send a heartbeat, the connection is probably dead
                    if (sessions[sessionId]) {
                        if (sessions[sessionId].heartbeatTimer) {
                            clearInterval(sessions[sessionId].heartbeatTimer);
                        }
                        delete sessions[sessionId];
                    }
                }
            };
            // Start heartbeat timer
            sessionData.heartbeatTimer = setInterval(heartbeat, heartbeatInterval);
            // Store session data
            sessions[sessionId] = sessionData;
            // Send initial heartbeat
            heartbeat();
        }
        sseTransport.onclose = () => {
            logger.info(`SSE connection closed (session ${sessionId})`);
            if (sessions[sessionId]?.heartbeatTimer) {
                clearInterval(sessions[sessionId].heartbeatTimer);
            }
            delete sessions[sessionId];
        };
        sseTransport.onerror = err => {
            logger.error(`SSE error (session ${sessionId}):`, err);
            if (sessions[sessionId]?.heartbeatTimer) {
                clearInterval(sessions[sessionId].heartbeatTimer);
            }
            delete sessions[sessionId];
        };
        // Handle client disconnection
        req.on('close', () => {
            logger.info(`Client disconnected (session ${sessionId})`);
            if (sessions[sessionId]?.heartbeatTimer) {
                clearInterval(sessions[sessionId].heartbeatTimer);
            }
            delete sessions[sessionId];
        });
    }));
    // Message endpoint with activity tracking
    app.post(messagePath, asyncHandler(async (req, res) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            return res.status(400).send('Missing sessionId parameter');
        }
        const session = sessions[sessionId];
        if (session?.transport?.handlePostMessage) {
            logger.debug(`POST to SSE transport (session ${sessionId})`);
            // Update last activity timestamp
            session.lastActivity = Date.now();
            try {
                await session.transport.handlePostMessage(req, res);
            }
            catch (err) {
                logger.error(`Error handling POST message (session ${sessionId}):`, err);
                // If not already sent, send a 500 response
                if (!res.headersSent) {
                    res.status(500).send('Error processing message');
                }
            }
        }
        else {
            res.status(503).send(`No active SSE connection for session ${sessionId}`);
        }
    }));
    // Start the server with graceful error handling
    const httpServer = app.listen(port, () => {
        logger.info(`Proxy server listening on port ${port}`);
        logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`);
        logger.info(`POST messages: http://localhost:${port}${messagePath}`);
    });
    // Handle server errors
    httpServer.on('error', (err) => {
        logger.error('HTTP server error:', err);
    });
    return { cleanup };
}
// ----- Main Function -----
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('config', {
        type: 'string',
        alias: 'c',
        description: 'Path to a JSON configuration file',
        demandOption: true
    })
        .option('port', {
        type: 'number',
        default: 3006,
        description: 'Port to run the proxy server on'
    })
        .option('baseUrl', {
        type: 'string',
        description: 'Base URL for SSE clients'
    })
        .option('ssePath', {
        type: 'string',
        default: '/sse',
        description: 'Path for SSE subscriptions'
    })
        .option('messagePath', {
        type: 'string',
        default: '/message',
        description: 'Path for SSE messages'
    })
        .option('logLevel', {
        choices: ['info', 'none', 'debug'],
        default: 'info',
        description: 'Set logging level: "info", "debug", or "none"'
    })
        .option('cors', {
        type: 'boolean',
        default: true,
        description: 'Enable CORS'
    })
        .option('healthEndpoint', {
        type: 'array',
        default: [],
        description: 'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz'
    })
        .option('timeout', {
        type: 'number',
        default: 30000,
        description: 'Connection timeout in milliseconds'
    })
        .option('debug', {
        type: 'boolean',
        default: false,
        description: 'Enable debug logging (same as --logLevel debug)'
    })
        .help()
        .parseSync();
    // Determine logger based on logLevel or debug flag
    let logger;
    if (argv.debug || argv.logLevel === 'debug') {
        logger = debugLogger;
    }
    else if (argv.logLevel === 'none') {
        logger = noneLogger;
    }
    else {
        logger = infoLogger;
    }
    try {
        // Load configuration file
        logger.info(`Loading configuration from: ${argv.config}`);
        const configPath = isAbsolute(argv.config) ? argv.config : join(process.cwd(), argv.config);
        logger.info(`Resolved config path to: ${configPath}`);
        let config;
        try {
            const configFileContent = readFileSync(configPath, 'utf-8');
            config = JSON.parse(configFileContent);
            // Validate config
            if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
                throw new Error('Config file must have a non-empty "mcpServers" object');
            }
        }
        catch (err) {
            logger.error(`Error loading or parsing config file "${configPath}":`, err.message);
            process.exit(1);
        }
        // Override config with command line arguments if provided
        config.port = argv.port ?? config.port;
        config.baseUrl = argv.baseUrl ?? config.baseUrl;
        config.ssePath = argv.ssePath ?? config.ssePath;
        config.messagePath = argv.messagePath ?? config.messagePath;
        config.logLevel = argv.logLevel;
        config.cors = argv.cors ?? config.cors;
        config.healthEndpoints = argv.healthEndpoint.length > 0
            ? argv.healthEndpoint
            : config.healthEndpoints;
        config.timeout = argv.timeout ?? config.timeout;
        // Start the proxy server
        await startProxyServer({ config, logger });
    }
    catch (err) {
        logger.error('Fatal error:', err);
        process.exit(1);
    }
}
main();
