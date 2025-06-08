#!/usr/bin/env node

/**
 * MCP SuperAssistant Proxy with Backwards Compatibility
 * 
 * This proxy aggregates multiple MCP servers and provides automatic backwards compatibility:
 * 
 * Server-side backwards compatibility:
 * - Provides modern Streamable HTTP transport (protocol version 2025-03-26) as primary
 * - Provides legacy HTTP+SSE transport (protocol version 2024-11-05) as fallback
 * 
 * Client-side backwards compatibility:
 * - When connecting to remote HTTP servers, tries Streamable HTTP first
 * - Automatically falls back to SSE transport if modern transport fails
 * 
 * Following the MCP specification for backwards compatibility.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { 
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  GetPromptResultSchema,
  Tool,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from "fs/promises";
import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import express from "express";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Configuration types
interface MCPServerConfig {
 name: string;
 type?: "stdio" | "http" | "sse" | "stream"; // Optional for backward compatibility
 command?: string;
 args?: string[];
 env?: Record<string, string>;
 url?: string;
 endpoint?: string;
 port?: number;
}

interface MCPConfig {
 mcpServers: Record<string, MCPServerConfig>;
}

interface ConnectedServer {
 name: string;
 client: Client;
 config: MCPServerConfig;
 childProcess?: ChildProcess; // Track child processes for stdio transports
 tools: Array<{
   name: string;
   description?: string;
   inputSchema: any;
 }>;
 resources: Array<{
   uri: string;
   name?: string;
   description?: string;
   mimeType?: string;
 }>;
 prompts: Array<{
   name: string;
   description?: string;
   arguments?: any[];
 }>;
}

interface MCPSuperAssistantProxyOptions {
  config: MCPConfig;
  logLevel: 'info' | 'debug' | 'none';
  cors: boolean;
  healthEndpoints: string[];
  timeout: number;
  maxConcurrentRequestsPerSession: number;
  maxConcurrentServerConnections?: number;
}

class MCPSuperAssistantProxy {
 private connectedServers: Map<string, ConnectedServer> = new Map();
 private server: Server;
 private app: express.Application;
 private config: MCPConfig;
 private options: MCPSuperAssistantProxyOptions;
 private transports: {
   streamable: Record<string, {
     transport: StreamableHTTPServerTransport;
     server: Server;
     createdAt: number;
     lastActivity: number;
     activeRequests: number;
   }>;
   sse: Record<string, {
     transport: SSEServerTransport;
     server: Server;
     response: express.Response;
     createdAt?: number;
     lastActivity?: number;
     keepAliveInterval?: NodeJS.Timeout;
     connectionState?: 'active' | 'closed' | 'error';
     errorCount?: number;
     keepAliveSuccess?: number;
   }>;
 } = {
   streamable: {},
   sse: {}
 };
 private httpServer?: any;

 constructor(options: MCPSuperAssistantProxyOptions) {
   this.config = options.config;
   this.options = options;
   this.server = new Server({
     name: "MCP SuperAssistant Proxy",
     version: "1.0.0"
   }, {
     capabilities: {
       tools: {},
       resources: {},
       prompts: {},
     }
   });
   
   this.app = express();
   this.app.use(express.json());
   
   // Add global CORS middleware
   this.app.use((req, res, next) => {
     res.setHeader('Access-Control-Allow-Origin', '*');
     res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
     res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Cache-Control');
     res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, Content-Type');
     
     // Handle preflight requests
     if (req.method === 'OPTIONS') {
       res.status(200).end();
       return;
     }
     
     next();
   });
   
   this.setupRoutes();
   this.setupServerHandlers();
   
   // Start periodic cleanup of stale sessions (every 10 seconds for faster detection)
   setInterval(() => {
     this.cleanupStaleStreamableSessions();
     this.cleanupStaleSSESessions();
   }, 10 * 1000);
 }

 private async safeAsyncOperation<T>(operation: () => Promise<T>, timeoutMs: number = 5000, description: string = 'operation'): Promise<T | null> {
   try {
     return await Promise.race([
       operation(),
       new Promise<never>((_, reject) => 
         setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs)
       )
     ]);
   } catch (error) {
     if (this.options.logLevel === 'debug') {
       const errorMsg = this.formatNetworkError(error);
       console.log(`Safe async operation failed (${description}): ${errorMsg}`);
     }
     return null;
   }
 }

 private setupRoutes(): void {
   // Health endpoints (must be set up before other routes)
   for (const endpoint of this.options.healthEndpoints) {
     this.app.get(endpoint, (req, res) => {
       res.setHeader('Content-Type', 'text/plain');
       res.status(200).send('ok');
     });
     
     if (this.options.logLevel === 'debug') {
       console.log(`Health endpoint configured: ${endpoint}`);
     }
   }

   // Unified MCP endpoint with proper session management
   this.app.post('/mcp', async (req, res) => {
     try {
       // Check for existing session ID
       const sessionId = req.headers['mcp-session-id'] as string | undefined;
       let transport: StreamableHTTPServerTransport;

       if (this.options.logLevel === 'debug') {
         console.log(`POST /mcp request from ${req.ip}, sessionId: ${sessionId || 'none'}, active sessions: ${Object.keys(this.transports.streamable).length}`);
       }

       if (sessionId && this.transports.streamable[sessionId]) {
         // Check concurrent request limit
         const session = this.transports.streamable[sessionId];
         if (session.activeRequests >= this.options.maxConcurrentRequestsPerSession) {
           res.status(429).json({
             jsonrpc: '2.0',
             error: {
               code: -32000,
               message: 'Too many concurrent requests for this session',
             },
             id: null,
           });
           return;
         }
         
         // Reuse existing transport and update activity
         transport = session.transport;
         session.lastActivity = Date.now();
         session.activeRequests++;
         
         if (this.options.logLevel === 'debug') {
           console.log(`Reusing existing session: ${sessionId}, active requests: ${session.activeRequests}`);
         }
       } else if (!sessionId && isInitializeRequest(req.body)) {
         // Check session limit
         const currentSessionCount = Object.keys(this.transports.streamable).length;
         if (currentSessionCount >= 100) {
           console.warn(`Session limit reached (${currentSessionCount} sessions). Rejecting new connection from ${req.ip}`);
           res.status(503).json({
             jsonrpc: '2.0',
             error: {
               code: -32000,
               message: 'Service temporarily unavailable: Too many active sessions',
             },
             id: null,
           });
           return;
         }
         
         // New initialization request - create a new server instance for this session
         if (this.options.logLevel === 'debug') {
           console.log(`Creating new session for initialize request from ${req.ip}`);
         }
         
         const sessionServer = new Server({
           name: "MCP SuperAssistant Proxy",
           version: "1.0.0"
         }, {
           capabilities: {
             tools: {},
             resources: {},
             prompts: {},
           }
         });

         // Copy all handlers from main server to session server
         this.copyServerHandlers(sessionServer);

         transport = new StreamableHTTPServerTransport({
           sessionIdGenerator: () => randomUUID(),
           onsessioninitialized: (newSessionId) => {
             // Store the transport by session ID with server and metadata
             this.transports.streamable[newSessionId] = {
               transport,
               server: sessionServer,
               createdAt: Date.now(),
               lastActivity: Date.now(),
               activeRequests: 1 // Initialize request is active
             };
             if (this.options.logLevel === 'debug') {
               console.log(`New Streamable HTTP session initialized: ${newSessionId}, total sessions: ${Object.keys(this.transports.streamable).length}`);
             }
           }
         });

         // Clean up transport when closed
         transport.onclose = () => {
           if (transport.sessionId) {
             if (this.options.logLevel === 'debug') {
               console.log(`Streamable HTTP session closed: ${transport.sessionId}, remaining sessions: ${Object.keys(this.transports.streamable).length - 1}`);
             }
             delete this.transports.streamable[transport.sessionId];
           }
         };

         // Connect the session server to the transport (not the main server)
         try {
           await sessionServer.connect(transport);
         } catch (connectError) {
           // Clean up on connection failure
           if (transport.sessionId) {
             delete this.transports.streamable[transport.sessionId];
           }
           throw connectError;
         }
       } else {
         // Invalid request
         if (this.options.logLevel === 'debug') {
           console.log(`Invalid request from ${req.ip}: sessionId=${sessionId}, isInitialize=${isInitializeRequest(req.body)}`);
         }
         res.status(400).json({
           jsonrpc: '2.0',
           error: {
             code: -32000,
             message: 'Bad Request: No valid session ID provided or not an initialize request',
           },
           id: null,
         });
         return;
       }

       // Handle the request
       try {
         await transport.handleRequest(req, res, req.body);
       } finally {
         // Decrease active request count after request completion
         if (sessionId && this.transports.streamable[sessionId]) {
           this.transports.streamable[sessionId].activeRequests--;
           if (this.options.logLevel === 'debug') {
             console.log(`Request completed for session ${sessionId}, active requests: ${this.transports.streamable[sessionId].activeRequests}`);
           }
         }
       }
     } catch (error) {
       console.error(`Error handling MCP request from ${req.ip}:`, error);
       res.status(500).json({
         jsonrpc: '2.0',
         error: {
           code: -32603,
           message: 'Internal error',
         },
         id: null,
       });
     }
   });

   // Handle GET requests for server-to-client notifications via SSE
   this.app.get('/mcp', async (req, res) => {
     const sessionId = req.headers['mcp-session-id'] as string | undefined;
     try {
       if (!sessionId || !this.transports.streamable[sessionId]) {
         if (this.options.logLevel === 'debug') {
           console.log(`GET /mcp: Invalid session ID ${sessionId} from ${req.ip}`);
         }
         res.status(400).send('Invalid or missing session ID');
         return;
       }
       
       const session = this.transports.streamable[sessionId];
       
       // Check concurrent request limit
       if (session.activeRequests >= this.options.maxConcurrentRequestsPerSession) {
         res.status(429).send('Too many concurrent requests for this session');
         return;
       }
       
       session.lastActivity = Date.now();
       session.activeRequests++;
       
       if (this.options.logLevel === 'debug') {
         console.log(`GET /mcp: Handling request for session ${sessionId} from ${req.ip}, active requests: ${session.activeRequests}`);
       }
       
       try {
         await session.transport.handleRequest(req, res);
       } finally {
         // Decrease active request count after request completion
         if (this.transports.streamable[sessionId]) {
           this.transports.streamable[sessionId].activeRequests--;
           if (this.options.logLevel === 'debug') {
             console.log(`GET request completed for session ${sessionId}, active requests: ${this.transports.streamable[sessionId].activeRequests}`);
           }
         }
       }
     } catch (error) {
       const errorMsg = this.formatNetworkError(error);
       if (this.options.logLevel === 'debug') {
         console.log(`GET /mcp error for session ${sessionId}: ${errorMsg}`);
       }
       console.error('Error handling GET request:', error);
       if (!res.headersSent) {
         res.status(500).send('Internal server error');
       }
     }
   });

   // Handle DELETE requests for session termination
   this.app.delete('/mcp', async (req, res) => {
     const sessionId = req.headers['mcp-session-id'] as string | undefined;
     try {
       if (!sessionId || !this.transports.streamable[sessionId]) {
         if (this.options.logLevel === 'debug') {
           console.log(`DELETE /mcp: Invalid session ID ${sessionId} from ${req.ip}`);
         }
         res.status(400).send('Invalid or missing session ID');
         return;
       }
       
       const session = this.transports.streamable[sessionId];
       
       if (this.options.logLevel === 'debug') {
         console.log(`DELETE /mcp: Terminating session ${sessionId} from ${req.ip}, active requests: ${session.activeRequests}`);
       }
       
       // Warn if there are active requests when terminating
       if (session.activeRequests > 0) {
         console.warn(`Terminating session ${sessionId} with ${session.activeRequests} active requests`);
       }
       
       session.lastActivity = Date.now();
       session.activeRequests++;
       
       try {
         await session.transport.handleRequest(req, res, req.body);
       } finally {
         // Clean up the session after handling the delete request
         delete this.transports.streamable[sessionId];
         
         if (this.options.logLevel === 'debug') {
           console.log(`DELETE /mcp: Session ${sessionId} terminated successfully`);
         }
       }
     } catch (error) {
       const errorMsg = this.formatNetworkError(error);
       if (this.options.logLevel === 'debug') {
         console.log(`DELETE /mcp error for session ${sessionId}: ${errorMsg}`);
       }
       console.error('Error handling DELETE request:', error);
       
       // Still clean up the session even if there was an error
       if (sessionId && this.transports.streamable[sessionId]) {
         delete this.transports.streamable[sessionId];
       }
       
       if (!res.headersSent) {
         res.status(500).send('Internal server error');
       }
     }
   });

   // Backward compatibility: SSE endpoint for legacy clients
   this.app.get('/sse', async (req, res) => {
     let sessionId: string | undefined;
     try {
         // Check SSE session limit
         const currentSSESessionCount = Object.keys(this.transports.sse).length;
         if (currentSSESessionCount >= 50) {
           console.warn(`SSE session limit reached (${currentSSESessionCount} sessions). Rejecting new connection from ${req.ip}`);
           res.status(503).send('Service temporarily unavailable: Too many active SSE sessions');
           return;
         }
         
         if (this.options.logLevel === 'debug') {
           console.log(`New SSE connection from ${req.ip}`);
         }
         
         // Set headers for SSE with enhanced keep-alive optimizations
         res.setHeader('Content-Type', 'text/event-stream');
         res.setHeader('Cache-Control', 'no-cache, no-transform');
         res.setHeader('Connection', 'keep-alive');
         res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in Nginx
         res.setHeader('Keep-Alive', 'timeout=300'); // 5 minutes keep-alive
         
         // Enhanced socket configuration for better stability
         req.socket.setKeepAlive(true, 15000); // Reduced TCP keep-alive probe to 15s
         req.socket.setTimeout(0); // Disable socket timeout
       
       // Create SSE transport with correct message endpoint
       const protocol = req.get('X-Forwarded-Proto') || (req.secure ? 'https' : 'http');
       const host = req.get('Host') || `localhost:${req.socket.localPort || 3006}`;
       const baseUrl = `${protocol}://${host}`;
       const messageEndpoint = `${baseUrl}/messages`;
       
       const sseTransport = new SSEServerTransport(messageEndpoint, res);
       
       // Create a new server instance for this SSE connection
       const sseServer = new Server({
         name: "MCP SuperAssistant Proxy SSE",
         version: "1.0.0"
       }, {
         capabilities: {
           tools: {},
           resources: {},
           prompts: {},
         }
       });
       
       // Copy all handlers from main server to SSE server
       this.copyServerHandlers(sseServer);
       
       await sseServer.connect(sseTransport);
       
       sessionId = sseTransport.sessionId;
       if (sessionId) {
         // Store session data with enhanced metadata
         this.transports.sse[sessionId] = {
           transport: sseTransport,
           server: sseServer,
           response: res,
           createdAt: Date.now(),
           lastActivity: Date.now(),
           connectionState: 'active',
           errorCount: 0,
           keepAliveSuccess: 0
         };
         
         if (this.options.logLevel === 'debug') {
           console.log(`SSE session created: ${sessionId}`);
         }
         
         // Enhanced keep-alive mechanism with error recovery
         const keepAliveInterval = setInterval(() => {
           try {
             if (sessionId && this.transports.sse[sessionId]) {
               // Check socket status first
               const socket = res.socket;
               if (!socket || socket.destroyed || !socket.writable) {
                 clearInterval(keepAliveInterval);
                 if (this.options.logLevel === 'debug') {
                   console.log(`Keep-alive detected dead socket for session ${sessionId}, cleaning up`);
                 }
                 this.cleanupSSESession(sessionId);
                 return;
               }
               
               // Send SSE comment as keep-alive
               const writeSuccess = res.write(':keepalive\n\n');
               
               if (!writeSuccess) {
                 clearInterval(keepAliveInterval);
                 if (this.options.logLevel === 'debug') {
                   console.log(`Keep-alive write failed for session ${sessionId}, cleaning up`);
                 }
                 this.cleanupSSESession(sessionId);
                 return;
               }
               
               this.transports.sse[sessionId].lastActivity = Date.now();
               
               // Track successful keep-alives
               const session = this.transports.sse[sessionId];
               if (session) {
                 if (!session.keepAliveSuccess) {
                   session.keepAliveSuccess = 0;
                 }
                 session.keepAliveSuccess++;
                 
                 if (this.options.logLevel === 'debug' && session.keepAliveSuccess % 10 === 0) {
                   console.log(`SSE session ${sessionId}: ${session.keepAliveSuccess} successful keep-alives`);
                 }
               }
             } else {
               // Session no longer exists, clear interval
               clearInterval(keepAliveInterval);
             }
           } catch (error) {
             // Connection might be closed, clean up
             clearInterval(keepAliveInterval);
             if (this.options.logLevel === 'debug') {
               const errorMsg = this.formatNetworkError(error);
               console.log(`Keep-alive failed for session ${sessionId}: ${errorMsg}`);
             }
             // Trigger cleanup
             this.cleanupSSESession(sessionId);
           }
         }, 15000); // Reduced keep-alive interval to 15 seconds for better stability
         
         // Store interval reference for cleanup
         if (sessionId && this.transports.sse[sessionId]) {
           (this.transports.sse[sessionId] as any).keepAliveInterval = keepAliveInterval;
         }
       }
       
       // Set up cleanup flag to prevent recursive cleanup calls
       let isCleaningUp = false;
       const safeCleanup = () => {
         if (isCleaningUp) return;
         isCleaningUp = true;
         this.cleanupSSESession(sessionId);
       };

       // Enhanced transport event handlers with error recovery
       sseTransport.onclose = () => {
         if (this.options.logLevel === 'debug') {
           console.log(`SSE transport closed (session ${sessionId})`);
         }
         if (sessionId && this.transports.sse[sessionId]) {
           this.transports.sse[sessionId].connectionState = 'closed';
         }
         safeCleanup();
       };
       
       sseTransport.onerror = (err) => {
         if (sessionId && this.transports.sse[sessionId]) {
           const session = this.transports.sse[sessionId];
           session.errorCount = (session.errorCount || 0) + 1;
           
           const errorMsg = this.formatNetworkError(err);
           const errorCategory = this.categorizeError(err);
           
           if (this.options.logLevel === 'debug') {
             console.log(`SSE transport error (session ${sessionId}): ${errorMsg}, category: ${errorCategory}, count: ${session.errorCount}`);
           }
           
           // Only cleanup on critical errors or after too many errors
           if (errorCategory === 'critical' || session.errorCount > 5) {
             session.connectionState = 'error';
             safeCleanup();
           }
         } else {
           safeCleanup();
         }
       };
       
       // Handle client disconnection
       req.on('close', () => {
         if (this.options.logLevel === 'debug') {
           console.log(`SSE client disconnected (session ${sessionId})`);
         }
         safeCleanup();
       });
       
       req.on('error', (err: any) => {
         // Only log actual errors in debug mode, not normal disconnections
         if (this.options.logLevel === 'debug' && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
           const errorMsg = this.formatNetworkError(err);
           console.log(`SSE client error (session ${sessionId}): ${errorMsg}`);
         }
         safeCleanup();
       });
       
     } catch (error) {
       console.error('Error setting up SSE connection:', error);
       
       // Clean up any partially created session
       if (sessionId) {
         this.cleanupSSESession(sessionId);
       }
       
       if (!res.headersSent) {
         res.status(500).send('Internal server error');
       }
     }
   });

   // Handle POST requests to SSE endpoint (for clients trying StreamableHTTP on SSE endpoint)
   this.app.post('/sse', async (req, res) => {
     res.status(400).json({
       error: 'SSE endpoint only supports GET requests. Use POST requests to /mcp for StreamableHTTP transport.',
       supportedMethods: ['GET'],
       suggestedEndpoint: '/mcp'
     });
   });

   // Backward compatibility: Messages endpoint for SSE transport
   this.app.post('/messages', async (req, res) => {
     try {
       const sessionId = req.query.sessionId as string;
       if (!sessionId) {
         res.status(400).send('Missing sessionId parameter');
         return;
       }
       
       const session = this.transports.sse[sessionId];
       if (session?.transport?.handlePostMessage) {
         if (this.options.logLevel === 'debug') {
           console.log(`POST to SSE transport (session ${sessionId})`);
         }
         
         // Update last activity timestamp
         session.lastActivity = Date.now();
         
         try {
           await session.transport.handlePostMessage(req, res, req.body);
         } catch (err) {
           const errorMsg = this.formatNetworkError(err);
           if (this.options.logLevel === 'debug') {
             console.log(`Error handling POST message (session ${sessionId}): ${errorMsg}`);
           }
           
           // If not already sent, send a 500 response
           if (!res.headersSent) {
             res.status(500).send('Error processing message');
           }
         }
       } else {
         res.status(503).send(`No active SSE connection for session ${sessionId}`);
       }
     } catch (error) {
       console.error('Error handling SSE message:', error);
       res.status(500).send('Internal server error');
     }
   });
 }

 private setupServerHandlers(): void {
   // Set up tool handlers
   this.server.setRequestHandler(ListToolsRequestSchema, async () => {
     const allTools = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const tool of server.tools) {
         allTools.push({
           name: `${serverName}.${tool.name}`,
           description: `[${serverName}] ${tool.description || tool.name}`,
           inputSchema: tool.inputSchema
         });
       }
     }
     
     // Add management tools
     allTools.push({
       name: "list_servers",
       description: "List all connected MCP servers and their capabilities",
       inputSchema: {
         type: "object",
         properties: {},
         additionalProperties: false
       }
     });
     
     allTools.push({
       name: "get_server_info", 
       description: "Get detailed information about a specific server",
       inputSchema: {
         type: "object",
         properties: {
           serverName: {
             type: "string",
             description: "Name of the server to get info for"
           }
         },
         required: ["serverName"],
         additionalProperties: false
       }
     });

     return { tools: allTools };
   });

   // Set up tool call handler
   this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
     const { name, arguments: args } = request.params;
     
     if (name === "list_servers") {
       const serverInfo = Array.from(this.connectedServers.entries()).map(([name, server]) => ({
         name,
         type: server.config.type,
         tools: server.tools.length,
         resources: server.resources.length,
         prompts: server.prompts.length,
         toolNames: server.tools.map(t => `${name}.${t.name}`),
       }));
       
       return {
         content: [{
           type: "text",
           text: JSON.stringify(serverInfo, null, 2)
         }]
       };
     }
     
     if (name === "get_server_info") {
       const serverName = args?.serverName;
       if (typeof serverName !== 'string') {
         return {
           content: [{
             type: "text", 
             text: `Invalid serverName parameter. Expected string, got ${typeof serverName}`
           }],
           isError: true
         };
       }
       
       const server = this.connectedServers.get(serverName);
       if (!server) {
         return {
           content: [{
             type: "text", 
             text: `Server '${serverName}' not found`
           }],
           isError: true
         };
       }
       
       return {
         content: [{
           type: "text",
           text: JSON.stringify({
             name: server.name,
             type: server.config.type,
             tools: server.tools,
             resources: server.resources,
             prompts: server.prompts,
           }, null, 2)
         }]
       };
     }
     
     // Handle delegated tool calls
     const [serverName, toolName] = name.split('.', 2);
     if (!serverName || !toolName) {
       return {
         content: [{
           type: "text",
           text: `Invalid tool name format. Use server_name.tool_name`
         }],
         isError: true
       };
     }
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       return {
         content: [{
           type: "text",
           text: `Server '${serverName}' not found`
         }],
         isError: true
       };
     }
     
     try {
       const result = await server.client.callTool({
         name: toolName,
         arguments: args || {},
       });
       
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       return {
         content: [{
           type: "text",
           text: `Failed to execute ${name}: ${errorMessage}`
         }],
         isError: true
       };
     }
   });

   // Set up resource handlers
   this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
     const allResources = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const resource of server.resources) {
         allResources.push({
           uri: `${serverName}://${resource.uri}`,
           name: `[${serverName}] ${resource.name || resource.uri}`,
           description: resource.description,
           mimeType: resource.mimeType
         });
       }
     }
     return { resources: allResources };
   });

   this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
     const { uri } = request.params;
     const [serverName, ...uriParts] = uri.split('://');
     const originalUri = uriParts.join('://');
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       throw new Error(`Server '${serverName}' not found`);
     }
     
     try {
       const result = await server.client.readResource({
         uri: originalUri,
       });
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       throw new Error(`Failed to read resource ${uri}: ${errorMessage}`);
     }
   });

   // Set up prompt handlers
   this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
     const allPrompts = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const prompt of server.prompts) {
         allPrompts.push({
           name: `${serverName}.${prompt.name}`,
           description: `[${serverName}] ${prompt.description || prompt.name}`,
           arguments: prompt.arguments || []
         });
       }
     }
     return { prompts: allPrompts };
   });

   this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
     const { name, arguments: args } = request.params;
     
     const [serverName, promptName] = name.split('.', 2);
     if (!serverName || !promptName) {
       throw new Error(`Invalid prompt name format. Use server_name.prompt_name`);
     }
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       throw new Error(`Server '${serverName}' not found`);
     }
     
     try {
       const result = await server.client.getPrompt({
         name: promptName,
         arguments: args || {},
       });
       
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       throw new Error(`Failed to get prompt ${name}: ${errorMessage}`);
     }
   });
 }

 private cleanupSSESession(sessionId: string | undefined): void {
   if (!sessionId || !this.transports.sse[sessionId]) {
     return;
   }
   
   const session = this.transports.sse[sessionId];
   
   if (this.options.logLevel === 'debug' || this.options.logLevel === 'info') {
     console.log(`Cleaning up SSE session: ${sessionId} (keep-alives: ${session.keepAliveSuccess || 0}, state: ${session.connectionState || 'unknown'})`);
   }
   
   // Clear keep-alive interval if exists
   if (session.keepAliveInterval) {
     clearInterval(session.keepAliveInterval);
   }
   
   // Remove from tracking first to prevent re-entry
   delete this.transports.sse[sessionId];
   
   // Force close the response stream
   try {
     if (session.response && !session.response.headersSent) {
       session.response.end();
     } else if (session.response) {
       // Force destroy the underlying socket
       const socket = session.response.socket;
       if (socket && !socket.destroyed) {
         socket.destroy();
       }
     }
   } catch (error) {
     if (this.options.logLevel === 'debug') {
       const errorMsg = this.formatNetworkError(error);
       console.log(`Error closing response for session ${sessionId}: ${errorMsg}`);
     }
   }
   
   // Close the transport if possible
   try {
     if (session.transport && typeof session.transport.close === 'function') {
       session.transport.close();
     }
   } catch (error) {
     // Silently handle transport close errors to prevent stack overflow
     if (this.options.logLevel === 'debug') {
       const errorMsg = this.formatNetworkError(error);
       console.log(`Error closing SSE transport for session ${sessionId}: ${errorMsg}`);
     }
   }
   
   // Close the server connection if possible
   try {
     if (session.server && typeof session.server.close === 'function') {
       session.server.close();
     }
   } catch (error) {
     // Silently handle server close errors to prevent stack overflow
     if (this.options.logLevel === 'debug') {
       const errorMsg = this.formatNetworkError(error);
       console.log(`Error closing SSE server for session ${sessionId}: ${errorMsg}`);
     }
   }
 }

 private cleanupStaleStreamableSessions(): void {
   const now = Date.now();
   const staleThreshold = 5 * 60 * 1000; // 5 minutes for better stability
   
   const sessionCount = Object.keys(this.transports.streamable).length;
   if (this.options.logLevel === 'info' && sessionCount > 0) {
     console.log(`Active streamable sessions: ${sessionCount}`);
   }
   
   for (const [sessionId, sessionData] of Object.entries(this.transports.streamable)) {
     const lastActivity = sessionData.lastActivity || sessionData.createdAt;
     const inactiveTime = now - lastActivity;
     
     if (inactiveTime > staleThreshold) {
       // Check if there are active requests before cleaning up
       if (sessionData.activeRequests > 0) {
         if (this.options.logLevel === 'debug') {
           console.log(`Delaying cleanup of session ${sessionId}: has ${sessionData.activeRequests} active requests (inactive: ${Math.round(inactiveTime / 1000)}s)`);
         }
         // Skip cleanup if there are active requests - they might be long-running
         continue;
       }
       
       if (this.options.logLevel === 'debug' || this.options.logLevel === 'info') {
         console.log(`Cleaning up stale streamable session: ${sessionId} (inactive: ${Math.round(inactiveTime / 1000)}s, active requests: ${sessionData.activeRequests})`);
       }
       
       try {
         if (sessionData.transport && typeof sessionData.transport.close === 'function') {
           sessionData.transport.close();
         }
         if (sessionData.server && typeof sessionData.server.close === 'function') {
           sessionData.server.close();
         }
       } catch (error) {
         console.error(`Error closing stale session ${sessionId}:`, error);
       }
       
       delete this.transports.streamable[sessionId];
     }
   }
 }

 private cleanupStaleSSESessions(): void {
   const now = Date.now();
   const staleThreshold = 2 * 60 * 1000; // Reduced to 2 minutes for faster cleanup
   const deadConnectionThreshold = 60 * 1000; // 1 minute for dead connections
   
   const sessionCount = Object.keys(this.transports.sse).length;
   if (this.options.logLevel === 'info' && sessionCount > 0) {
     console.log(`Active SSE sessions: ${sessionCount}`);
   }
   
   for (const [sessionId, sessionData] of Object.entries(this.transports.sse)) {
     const lastActivity = sessionData.lastActivity || sessionData.createdAt || now;
     const inactiveTime = now - lastActivity;
     
     // Check if connection is dead (no keep-alive success)
     const isDead = sessionData.connectionState === 'closed' || 
                    sessionData.connectionState === 'error' ||
                    (sessionData.keepAliveSuccess === 0 && inactiveTime > deadConnectionThreshold);
     
     // Clean up dead connections immediately
     if (isDead) {
       if (this.options.logLevel === 'debug' || this.options.logLevel === 'info') {
         console.log(`Cleaning up dead SSE session: ${sessionId} (state: ${sessionData.connectionState}, inactive: ${Math.round(inactiveTime / 1000)}s)`);
       }
       this.cleanupSSESession(sessionId);
       continue;
     }
     
     // Clean up stale connections
     if (inactiveTime > staleThreshold) {
       if (this.options.logLevel === 'debug' || this.options.logLevel === 'info') {
         console.log(`Cleaning up stale SSE session: ${sessionId} (inactive: ${Math.round(inactiveTime / 1000)}s, keep-alives: ${sessionData.keepAliveSuccess || 0})`);
       }
       
       // Try to write a test message to check if connection is still alive
       try {
         if (sessionData.response) {
           // Check if socket is still writable
           const socket = sessionData.response.socket;
           if (!socket || socket.destroyed || !socket.writable) {
             if (this.options.logLevel === 'debug') {
               console.log(`SSE session ${sessionId} has dead socket, cleaning up`);
             }
             this.cleanupSSESession(sessionId);
             continue;
           }
           
           // Try to write ping
           const writeSuccess = sessionData.response.write(':ping\n\n');
           if (!writeSuccess) {
             if (this.options.logLevel === 'debug') {
               console.log(`SSE session ${sessionId} write failed, cleaning up`);
             }
             this.cleanupSSESession(sessionId);
           }
         }
       } catch (error) {
         // Connection is dead, clean it up
         if (this.options.logLevel === 'debug') {
           console.log(`SSE session ${sessionId} failed ping test, cleaning up`);
         }
         this.cleanupSSESession(sessionId);
       }
     }
   }
 }

 private copyServerHandlers(sseServer: Server): void {
   // Copy all the request handlers from the main server to the SSE server
   // This ensures SSE clients get the same functionality
   
   // Set up tool handlers
   sseServer.setRequestHandler(ListToolsRequestSchema, async () => {
     const allTools = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const tool of server.tools) {
         allTools.push({
           name: `${serverName}.${tool.name}`,
           description: `[${serverName}] ${tool.description || tool.name}`,
           inputSchema: tool.inputSchema
         });
       }
     }
     
     // Add management tools
     allTools.push({
       name: "list_servers",
       description: "List all connected MCP servers and their capabilities",
       inputSchema: {
         type: "object",
         properties: {},
         additionalProperties: false
       }
     });
     
     allTools.push({
       name: "get_server_info", 
       description: "Get detailed information about a specific server",
       inputSchema: {
         type: "object",
         properties: {
           serverName: {
             type: "string",
             description: "Name of the server to get info for"
           }
         },
         required: ["serverName"],
         additionalProperties: false
       }
     });

     return { tools: allTools };
   });

   // Set up tool call handler
   sseServer.setRequestHandler(CallToolRequestSchema, async (request) => {
     const { name, arguments: args } = request.params;
     
     if (name === "list_servers") {
       const serverInfo = Array.from(this.connectedServers.entries()).map(([name, server]) => ({
         name,
         type: server.config.type,
         tools: server.tools.length,
         resources: server.resources.length,
         prompts: server.prompts.length,
         toolNames: server.tools.map(t => `${name}.${t.name}`),
       }));
       
       return {
         content: [{
           type: "text",
           text: JSON.stringify(serverInfo, null, 2)
         }]
       };
     }
     
     if (name === "get_server_info") {
       const serverName = args?.serverName;
       if (typeof serverName !== 'string') {
         return {
           content: [{
             type: "text", 
             text: `Invalid serverName parameter. Expected string, got ${typeof serverName}`
           }],
           isError: true
         };
       }
       
       const server = this.connectedServers.get(serverName);
       if (!server) {
         return {
           content: [{
             type: "text", 
             text: `Server '${serverName}' not found`
           }],
           isError: true
         };
       }
       
       return {
         content: [{
           type: "text",
           text: JSON.stringify({
             name: server.name,
             type: server.config.type,
             tools: server.tools,
             resources: server.resources,
             prompts: server.prompts,
           }, null, 2)
         }]
       };
     }
     
     // Handle delegated tool calls
     const [serverName, toolName] = name.split('.', 2);
     if (!serverName || !toolName) {
       return {
         content: [{
           type: "text",
           text: `Invalid tool name format. Use server_name.tool_name`
         }],
         isError: true
       };
     }
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       return {
         content: [{
           type: "text",
           text: `Server '${serverName}' not found`
         }],
         isError: true
       };
     }
     
     try {
       const result = await server.client.callTool({
         name: toolName,
         arguments: args || {},
       });
       
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       return {
         content: [{
           type: "text",
           text: `Failed to execute ${name}: ${errorMessage}`
         }],
         isError: true
       };
     }
   });

   // Set up resource handlers
   sseServer.setRequestHandler(ListResourcesRequestSchema, async () => {
     const allResources = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const resource of server.resources) {
         allResources.push({
           uri: `${serverName}://${resource.uri}`,
           name: `[${serverName}] ${resource.name || resource.uri}`,
           description: resource.description,
           mimeType: resource.mimeType
         });
       }
     }
     return { resources: allResources };
   });

   sseServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
     const { uri } = request.params;
     const [serverName, ...uriParts] = uri.split('://');
     const originalUri = uriParts.join('://');
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       throw new Error(`Server '${serverName}' not found`);
     }
     
     try {
       const result = await server.client.readResource({
         uri: originalUri,
       });
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       throw new Error(`Failed to read resource ${uri}: ${errorMessage}`);
     }
   });

   // Set up prompt handlers
   sseServer.setRequestHandler(ListPromptsRequestSchema, async () => {
     const allPrompts = [];
     for (const [serverName, server] of this.connectedServers) {
       for (const prompt of server.prompts) {
         allPrompts.push({
           name: `${serverName}.${prompt.name}`,
           description: `[${serverName}] ${prompt.description || prompt.name}`,
           arguments: prompt.arguments || []
         });
       }
     }
     return { prompts: allPrompts };
   });

   sseServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
     const { name, arguments: args } = request.params;
     
     const [serverName, promptName] = name.split('.', 2);
     if (!serverName || !promptName) {
       throw new Error(`Invalid prompt name format. Use server_name.prompt_name`);
     }
     
     const server = this.connectedServers.get(serverName);
     if (!server) {
       throw new Error(`Server '${serverName}' not found`);
     }
     
     try {
       const result = await server.client.getPrompt({
         name: promptName,
         arguments: args || {},
       });
       
       return result;
     } catch (error) {
       const errorMessage = error instanceof Error ? error.message : String(error);
       throw new Error(`Failed to get prompt ${name}: ${errorMessage}`);
     }
   });
 }

 private formatNetworkError(error: any): string {
   if (!error) {
     return 'Unknown error';
   }
   
   // Handle common network error codes
   if (error.code) {
     switch (error.code) {
       case 'ECONNRESET':
         return 'Connection reset by peer (client disconnected)';
       case 'ECONNABORTED':
         return 'Connection aborted';
       case 'ENOTFOUND':
         return 'Host not found';
       case 'ECONNREFUSED':
         return 'Connection refused';
       case 'ETIMEDOUT':
         return 'Connection timed out';
       case 'EPIPE':
         return 'Broken pipe (client disconnected)';
       default:
         return `Network error: ${error.code}`;
     }
   }
   
   // Handle error messages
   if (error.message) {
     return error.message;
   }
   
   // Fallback to string representation
   return String(error);
 }

 private categorizeError(error: any): 'transient' | 'critical' | 'unknown' {
   if (!error) {
     return 'unknown';
   }
   
   // Network errors that might recover
   const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'];
   // Critical errors that won't recover
   const criticalErrors = ['ECONNREFUSED', 'EACCES', 'EMFILE'];
   
   if (error.code) {
     if (transientErrors.includes(error.code)) {
       return 'transient';
     }
     if (criticalErrors.includes(error.code)) {
       return 'critical';
     }
   }
   
   // HTTP status codes
   if (error.status) {
     if (error.status >= 500 && error.status < 600) {
       return 'transient'; // Server errors might recover
     }
     if (error.status >= 400 && error.status < 500) {
       return 'critical'; // Client errors won't recover
     }
   }
   
   return 'unknown';
 }

 /**
  * Connect to an MCP server with backwards compatibility
  * Following the spec for client backward compatibility
  */
 private async connectWithBackwardsCompatibility(url: string, client: Client): Promise<{
   transport: any;
   transportType: 'streamable-http' | 'sse';
 }> {
   console.log('1. Trying Streamable HTTP transport first...');
   
   // Set up error handler
   client.onerror = (error) => {
     const errorMsg = this.formatNetworkError(error);
     if (this.options.logLevel === 'debug') {
       console.log(`Client connection error: ${errorMsg}`);
     }
   };

   const baseUrl = new URL(url);
   const connectionTimeout = this.options.timeout || 30000;
   
   let streamableTransport: any = null;
   try {
     // Create modern transport with timeout
     streamableTransport = new StreamableHTTPClientTransport(baseUrl);
     
     await Promise.race([
       client.connect(streamableTransport),
       new Promise<never>((_, reject) => 
         setTimeout(() => reject(new Error(`Streamable HTTP connection timeout after ${connectionTimeout}ms`)), connectionTimeout)
       )
     ]);
     
     console.log('Successfully connected using modern Streamable HTTP transport.');
     return {
       transport: streamableTransport,
       transportType: 'streamable-http'
     };
   } catch (error) {
     // Clean up failed transport and client
     if (streamableTransport) {
       try {
         if (typeof streamableTransport.close === 'function') {
           streamableTransport.close();
         }
       } catch (cleanupError) {
         // Ignore cleanup errors
       }
     }
     
     // Also try to close the client to free any resources
     try {
       await client.close();
     } catch (clientCloseError) {
       // Ignore client close errors
     }
     
     // Step 2: If transport fails, try the older SSE transport
     const errorMsg = this.formatNetworkError(error);
     console.log(`Streamable HTTP transport connection failed: ${errorMsg}`);
     console.log('2. Falling back to deprecated HTTP+SSE transport...');
     
     // Try SSE with retry mechanism
     let sseTransport: any = null;
     let retryCount = 0;
     const maxRetries = 3;
     let lastError: any = null;
     
     while (retryCount < maxRetries) {
       try {
         // Create SSE transport pointing to /sse endpoint
         const sseUrl = new URL(baseUrl);
         sseUrl.pathname = '/sse';
         
         sseTransport = new SSEClientTransport(sseUrl);
         
         await Promise.race([
           client.connect(sseTransport),
           new Promise<never>((_, reject) => 
             setTimeout(() => reject(new Error(`SSE connection timeout after ${connectionTimeout}ms`)), connectionTimeout)
           )
         ]);
         
         console.log('Successfully connected using deprecated HTTP+SSE transport.');
         
         return {
           transport: sseTransport,
           transportType: 'sse'
         };
       } catch (sseError) {
         lastError = sseError;
         retryCount++;
         
         // Clean up failed SSE transport
         if (sseTransport) {
           try {
             if (typeof sseTransport.close === 'function') {
               sseTransport.close();
             }
           } catch (cleanupError) {
             // Ignore cleanup errors
           }
         }
         
         // Also try to close the client to free any resources
         try {
           await client.close();
         } catch (clientCloseError) {
           // Ignore client close errors
         }
         
         if (retryCount < maxRetries) {
           const sseErrorMsg = this.formatNetworkError(sseError);
           console.log(`SSE connection attempt ${retryCount} failed: ${sseErrorMsg}. Retrying in ${retryCount}s...`);
           await new Promise(resolve => setTimeout(resolve, retryCount * 1000));
         }
       }
     }
     
     const sseErrorMsg = this.formatNetworkError(lastError);
     console.error(`Failed to connect with either transport method after ${maxRetries} SSE retries:\n1. Streamable HTTP error: ${errorMsg}\n2. SSE error: ${sseErrorMsg}`);
     throw new Error('Could not connect to server with any available transport');
   }
 }

 async initialize(): Promise<void> {
   console.log("Initializing MCP SuperAssistant proxy...");
  
   const serverEntries = Object.entries(this.config.mcpServers);
   const totalServers = serverEntries.length;
   
   // Validate batch size: must be positive integer, defaults to totalServers
   const batchSize = (!this.options.maxConcurrentServerConnections || 
                     this.options.maxConcurrentServerConnections <= 0 || 
                     !Number.isInteger(this.options.maxConcurrentServerConnections))
     ? totalServers 
     : Math.min(this.options.maxConcurrentServerConnections, totalServers);
   
   if (this.options.logLevel !== 'none') {
     if (batchSize < totalServers) {
       console.log(`Starting connection to ${totalServers} servers (batch size: ${batchSize})...`);
     } else {
       console.log(`Starting parallel connection to ${totalServers} servers...`);
     }
   }
   
   // Result collection
   const allResults: Array<{
     serverName: string;
     status: 'success' | 'failed';
     error?: any;
   }> = [];
   
   // Progress tracking
   let completed = 0;
   
   // Process servers in batches
   for (let i = 0; i < serverEntries.length; i += batchSize) {
     const batch = serverEntries.slice(i, i + batchSize);
     const batchNumber = Math.floor(i / batchSize) + 1;
     const totalBatches = Math.ceil(serverEntries.length / batchSize);
     
     if (this.options.logLevel !== 'none' && totalBatches > 1) {
       console.log(`\nProcessing batch ${batchNumber}/${totalBatches}...`);
     }
     
     const batchResults = await Promise.allSettled(
       batch.map(async ([serverName, serverConfig]) => {
         try {
           await this.connectToServer(serverName, serverConfig);
           return { serverName, status: 'success' as const };
         } catch (error) {
           console.error(`Failed to connect to server ${serverName}:`, error);
           return { serverName, status: 'failed' as const, error };
         }
       })
     );
     
     // Collect batch results
     batchResults.forEach((result) => {
       completed++;
       if (this.options.logLevel !== 'none' && totalServers > 5) {
         console.log(`Connection progress: ${completed}/${totalServers} servers`);
       }
       
       // Promise.allSettled always fulfills, so we only need to check the inner value
       allResults.push(result.status === 'fulfilled' ? result.value : {
         serverName: 'unknown',
         status: 'failed' as const,
         error: result.reason
       });
     });
   }
   
   const successful = allResults.filter(r => r.status === 'success').map(r => r.serverName);
   const failed = allResults.filter(r => r.status === 'failed').map(r => r.serverName);
   
   // Summarize results
   if (this.options.logLevel !== 'none') {
     console.log(`\nConnection summary:`);
     console.log(`✓ Successfully connected: ${successful.length} servers`);
     if (successful.length > 0 && this.options.logLevel === 'debug') {
       console.log(`  - ${successful.join(', ')}`);
     }
     if (failed.length > 0) {
       console.log(`✗ Failed connections: ${failed.length} servers`);
       console.log(`  - ${failed.join(', ')}`);
     }
   }
  
   console.log(`\nSuccessfully initialized mcpsuperassistantproxy with ${this.connectedServers.size} servers`);
 }

 private async connectToServer(serverName: string, config: MCPServerConfig): Promise<void> {
   // Infer transport type if not explicitly specified (backward compatibility)
   let transportType = config.type;
   if (!transportType) {
     if (config.command) {
       transportType = "stdio";
     } else if (config.url) {
       // Default to "http" for URLs - this will use backwards compatibility fallback
       transportType = "http";
     } else {
       throw new Error(`Unable to determine transport type for server ${serverName}. Please specify either 'command' for stdio or 'url' for HTTP transport.`);
     }
   }

   console.log(`Connecting to ${serverName} (${transportType}${!config.type ? ' - inferred' : ''})...`);

   const client = new Client(
     {
       name: `MCP-SuperAssistant-Proxy-Client-${serverName}`,
       version: "1.0.0",
     },
     {
       capabilities: {
         tools: {},
         resources: {},
         prompts: {},
       },
     }
   );

   // Set up error handler
   client.onerror = (error) => {
     const errorMsg = this.formatNetworkError(error);
     if (this.options.logLevel === 'debug') {
       console.log(`Client connection error for ${serverName}: ${errorMsg}`);
     }
   };

   // Add connection timeout
   const connectionTimeout = this.options.timeout || 30000;
   
   let transport;
   let childProcess: ChildProcess | undefined;

   try {
     switch (transportType) {
       case "stdio":
         if (!config.command) {
           throw new Error(`Command required for stdio server ${serverName}`);
         }
         // Merge custom environment variables with process environment
         const mergedEnv = {
           ...process.env as Record<string, string>,
           ...(config.env || {})
         };
         transport = new StdioClientTransport({
           command: config.command,
           args: config.args || [],
           env: mergedEnv,
         });
         
         // Access the child process for tracking
         if (transport && (transport as any).process) {
           childProcess = (transport as any).process;
           
           // Set up proper process group to allow clean termination
           if (childProcess && childProcess.pid) {
             if (this.options.logLevel === 'debug') {
               console.log(`Started child process ${childProcess.pid} for ${serverName}`);
             }
             
             // Detach from parent process group to prevent signal propagation
             try {
               if (process.platform !== 'win32') {
                 // On Unix-like systems, set new process group
                 process.kill(-childProcess.pid, 0); // Test if we can signal the process group
               }
             } catch (error) {
               // Ignore errors - process group handling is best effort
               if (this.options.logLevel === 'debug') {
                 console.log(`Could not set process group for ${serverName}: ${this.formatNetworkError(error)}`);
               }
             }
             
             // Handle process exit events
             childProcess.on('exit', (code, signal) => {
               if (this.options.logLevel === 'debug') {
                 console.log(`Child process ${childProcess?.pid} for ${serverName} exited with code ${code}, signal ${signal}`);
               }
             });
             
             childProcess.on('error', (error) => {
               if (this.options.logLevel === 'debug') {
                 console.log(`Child process error for ${serverName}: ${this.formatNetworkError(error)}`);
               }
             });
           }
         }
         break;

       case "http":
         if (!config.url) {
           throw new Error(`URL required for HTTP server ${serverName}`);
         }
         // Implement backwards compatibility - try modern transport first, fall back to SSE
         const connection = await this.connectWithBackwardsCompatibility(config.url, client);
         transport = connection.transport;
         break;

       case "sse":
         if (!config.url) {
           throw new Error(`URL required for SSE server ${serverName}`);
         }
         transport = new SSEClientTransport(new URL(config.url));
         break;

       case "stream":
         if (!config.url) {
           throw new Error(`URL required for stream server ${serverName}`);
         }
         transport = new StreamableHTTPClientTransport(new URL(config.url));
         break;

       default:
         throw new Error(`Unsupported transport type: ${transportType}`);
     }

     // Connect with timeout for non-http transports
     if (transportType === "stdio" || transportType === "sse" || transportType === "stream") {
       await Promise.race([
         client.connect(transport),
         new Promise<never>((_, reject) => 
           setTimeout(() => reject(new Error(`Connection timeout after ${connectionTimeout}ms`)), connectionTimeout)
         )
       ]);
     }
   } catch (error) {
     // Clean up transport on connection failure
     try {
       if (transport && typeof transport.close === 'function') {
         transport.close();
       }
     } catch (cleanupError) {
       // Ignore cleanup errors
     }
     throw error;
   }

   // Fetch server capabilities
   const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
     client.listTools().catch(() => ({ tools: [] })),
     client.listResources().catch(() => ({ resources: [] })),
     client.listPrompts().catch(() => ({ prompts: [] })),
   ]);

   const connectedServer: ConnectedServer = {
     name: serverName,
     client,
     config: { ...config, name: serverName, type: transportType },
     childProcess, // Track child process for cleanup
     tools: toolsResult.tools || [],
     resources: resourcesResult.resources || [],
     prompts: promptsResult.prompts || [],
   };

   this.connectedServers.set(serverName, connectedServer);
  
   console.log(`Connected to ${serverName}: ${connectedServer.tools.length} tools, ${connectedServer.resources.length} resources, ${connectedServer.prompts.length} prompts`);
 }

 private async terminateChildProcess(childProcess: ChildProcess, serverName: string): Promise<void> {
   if (!childProcess.pid) {
     return;
   }

   const pid = childProcess.pid;
   
   if (this.options.logLevel === 'debug') {
     console.log(`Terminating child process ${pid} for ${serverName}...`);
   }

   return new Promise<void>((resolve) => {
     let resolved = false;
     
     const cleanup = () => {
       if (!resolved) {
         resolved = true;
         resolve();
       }
     };

     // Listen for the process to exit
     childProcess.once('exit', cleanup);
     
     // Start with SIGTERM for graceful shutdown
     try {
       childProcess.kill('SIGTERM');
       
       // Give the process 5 seconds to exit gracefully
       const gracefulTimeout = setTimeout(() => {
         if (!resolved && childProcess.pid) {
           if (this.options.logLevel === 'debug') {
             console.log(`Child process ${pid} for ${serverName} didn't exit gracefully, sending SIGKILL`);
           }
           try {
             childProcess.kill('SIGKILL');
           } catch (error) {
             // Process may have already exited
           }
           
           // Give it another 2 seconds before giving up
           setTimeout(cleanup, 2000);
         }
       }, 5000);
       
       childProcess.once('exit', () => {
         clearTimeout(gracefulTimeout);
         if (this.options.logLevel === 'debug') {
           console.log(`Child process ${pid} for ${serverName} terminated successfully`);
         }
         cleanup();
       });
       
     } catch (error) {
       // Process may have already exited
       if (this.options.logLevel === 'debug') {
         console.log(`Error terminating child process ${pid} for ${serverName}: ${this.formatNetworkError(error)}`);
       }
       cleanup();
     }
   });
 }

 async start(options: {
   port: number;
 }): Promise<void> {
   const { port } = options;
   
   return new Promise((resolve, reject) => {
     this.httpServer = this.app.listen(port, (err?: Error) => {
       if (err) {
         reject(err);
         return;
       }
       
       console.log(`MCP SuperAssistant Proxy running with backwards compatibility at:`);
       console.log(`  - Modern Streamable HTTP: http://localhost:${port}/mcp`);
       console.log(`  - Legacy SSE: http://localhost:${port}/sse`);
       console.log(`  - Legacy messages: http://localhost:${port}/messages`);
       console.log(`\nClients should connect to http://localhost:${port}/mcp for automatic backwards compatibility.`);
       
       resolve();
     });
   });
 }

 async stop(): Promise<void> {
   console.log("Starting graceful shutdown...");
   
   // Create an array to track all cleanup operations
   const cleanupPromises: Promise<void>[] = [];
   
   // Close connections to all servers with timeout and handle child processes
   for (const [serverName, server] of Array.from(this.connectedServers)) {
     const cleanupPromise = this.safeAsyncOperation(
       async () => {
         try {
           // First close the client connection
           await server.client.close();
           console.log(`Disconnected from ${serverName}`);
           
           // If there's a child process, terminate it gracefully
           if (server.childProcess && server.childProcess.pid) {
             await this.terminateChildProcess(server.childProcess, serverName);
           }
         } catch (error) {
           const errorMsg = this.formatNetworkError(error);
           console.log(`Error disconnecting from ${serverName}: ${errorMsg}`);
           
           // Even if client close fails, try to terminate the child process
           if (server.childProcess && server.childProcess.pid) {
             await this.terminateChildProcess(server.childProcess, serverName);
           }
         }
       },
       10000, // Increased timeout to allow for graceful process termination
       `disconnect from ${serverName}`
     );
     cleanupPromises.push(cleanupPromise.then(() => {}));
   }
   
   // Clean up all SSE sessions
   for (const [sessionId, session] of Object.entries(this.transports.sse)) {
     const cleanupPromise = this.safeAsyncOperation(
       async () => {
         try {
           // Close the transport if possible
           if (session.transport && typeof session.transport.close === 'function') {
             session.transport.close();
           }
         } catch (error) {
           console.error(`Error cleaning up SSE session ${sessionId}:`, error);
         }
       },
       2000,
       `cleanup SSE session ${sessionId}`
     );
     cleanupPromises.push(cleanupPromise.then(() => {}));
   }
   this.transports.sse = {};
   
   // Clean up Streamable HTTP sessions
   for (const [sessionId, transportData] of Object.entries(this.transports.streamable)) {
     const cleanupPromise = this.safeAsyncOperation(
       async () => {
         try {
           if (transportData.transport && typeof transportData.transport.close === 'function') {
             transportData.transport.close();
           }
         } catch (error) {
           console.error(`Error cleaning up streamable session ${sessionId}:`, error);
         }
       },
       2000,
       `cleanup streamable session ${sessionId}`
     );
     cleanupPromises.push(cleanupPromise.then(() => {}));
   }
   this.transports.streamable = {};

   // Wait for all cleanup operations to complete (or timeout)
   try {
     await Promise.allSettled(cleanupPromises);
   } catch (error) {
     console.error("Error during parallel cleanup:", error);
   }

   // Stop the HTTP server
   if (this.httpServer) {
     return new Promise((resolve) => {
       const timeout = setTimeout(() => {
         console.error("HTTP server close timeout, forcing shutdown");
         resolve();
       }, 5000);
       
       this.httpServer.close((err: any) => {
         clearTimeout(timeout);
         if (err) {
           console.error("Error closing HTTP server:", err);
         } else {
           console.log("HTTP server closed successfully");
         }
         console.log("MCP SuperAssistant Proxy stopped");
         resolve();
       });
     });
   }
 }
}

// Main execution
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
    .option('logLevel', {
      choices: ['info', 'none', 'debug'] as const,
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
    .option('maxConcurrentRequestsPerSession', {
      type: 'number',
      default: 10,
      description: 'Maximum concurrent requests per session'
    })
    .option('maxConcurrentServerConnections', {
      type: 'number',
      description: 'Maximum number of servers to connect in parallel (default: unlimited)'
    })
    .option('debug', {
      type: 'boolean',
      default: false,
      description: 'Enable debug logging (same as --logLevel debug)'
    })
    .parseSync();

  try {
    // Load configuration
    const configContent = await readFile(argv.config, "utf-8");
    const config: MCPConfig = JSON.parse(configContent);

    // Create mcpsuperassistantproxy options
    const options: MCPSuperAssistantProxyOptions = {
      config,
      logLevel: argv.debug ? 'debug' : (argv.logLevel as 'info' | 'debug' | 'none'),
      cors: argv.cors,
      healthEndpoints: (argv.healthEndpoint as string[]) || [],
      timeout: argv.timeout,
      maxConcurrentRequestsPerSession: argv.maxConcurrentRequestsPerSession,
      maxConcurrentServerConnections: argv.maxConcurrentServerConnections
    };

    // Create and initialize mcpsuperassistantproxy
    const mcpsuperassistantproxy = new MCPSuperAssistantProxy(options);
    await mcpsuperassistantproxy.initialize();

    // Start the mcpsuperassistantproxy server
    await mcpsuperassistantproxy.start({
      port: argv.port,
    });

    // Handle graceful shutdown with improved error handling
    let isShuttingDown = false;
    
    // Add a cleanup function that can be called during process exit
    const performCleanup = async () => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;
      
      try {
        await mcpsuperassistantproxy.stop();
      } catch (error) {
        console.error("Error during cleanup:", error);
      }
    };
    
    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) {
        console.log(`\nReceived ${signal} during shutdown, forcing exit...`);
        process.exit(1);
      }
      
      isShuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down MCP SuperAssistant proxy gracefully...`);
      
      try {
        // Set a timeout for shutdown to prevent hanging
        const shutdownTimeout = setTimeout(() => {
          console.error("Shutdown timeout reached, forcing exit...");
          process.exit(1);
        }, 10000); // 10 second timeout

        await mcpsuperassistantproxy.stop();
        
        clearTimeout(shutdownTimeout);
        console.log("Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    
    // Handle other signals that might be sent
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
    process.on("SIGQUIT", () => gracefulShutdown("SIGQUIT"));
    
    // Handle unexpected process exit
    process.on("exit", (code) => {
      if (!isShuttingDown) {
        console.log(`Process exiting with code ${code}, cleanup may be incomplete`);
      }
    });
    
    // Handle SIGINT with better child process management
    process.on("beforeExit", async () => {
      if (!isShuttingDown) {
        await performCleanup();
      }
    });
    
    // Handle uncaught exceptions and unhandled rejections
    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error);
      if (!isShuttingDown) {
        gracefulShutdown("uncaughtException");
      }
    });
    
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled rejection at:", promise, "reason:", reason);
      if (!isShuttingDown) {
        gracefulShutdown("unhandledRejection");
      }
    });

  } catch (error) {
    console.error("Failed to start MCP SuperAssistant proxy:", error);
    process.exit(1);
  }
}

// Example usage information
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
 MCP SuperAssistant Proxy with Backwards Compatibility
 
 This proxy aggregates multiple MCP servers and provides backwards compatibility:
 - Modern clients use Streamable HTTP transport (protocol version 2025-03-26)
 - Legacy clients automatically fall back to HTTP+SSE transport (protocol version 2024-11-05)
 
 Usage: node index.ts --config <configPath> [options]
 
 Options:
  -c, --config        Path to mcpconfig.json (required)
  --port              Port to run on (default: 3006)
  --logLevel          Set logging level: "info", "debug", or "none" (default: "info")
  --cors              Enable CORS (default: true)
  --healthEndpoint    One or more health endpoints returning "ok"
  --timeout           Connection timeout in milliseconds (default: 30000)
  --maxConcurrentServerConnections  Maximum servers to connect in parallel (default: unlimited)
  --debug             Enable debug logging (same as --logLevel debug)
 
 Example mcpconfig.json:
 {
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "@suekou/mcp-notion-server"],
      "env": {
        "NOTION_API_TOKEN": "ntn_xxxxx"
      }
    },
    "iterm-mcp": {
      "command": "npx",
      "args": ["-y", "iterm-mcp"]
    },
    "filesystem-sse": {
      "url": "http://localhost:3005/sse"
    },
    "remote_server": {
      "name": "remote_server",
      "url": "http://localhost:8080/mcp"
    },
    "streamable_server": {
      "name": "streamable_server",
      "url": "http://localhost:9090/mcp"
    }
  }
 }
 
 Transport Types:
  - stdio: Local MCP servers via command line (inferred from "command")
           Supports "env" field for custom environment variables
  - http: Remote MCP servers with automatic backwards compatibility
          (inferred from "url", tries Streamable HTTP first, falls back to SSE)
  - sse: Explicit SSE transport for legacy servers (use "type": "sse")
  - stream: Explicit Streamable HTTP transport for modern servers (use "type": "stream")
 
 Note: Transport type is automatically inferred:
  - If "command" is present → stdio transport
  - If "url" is present → http transport with automatic fallback
  - Use explicit "type" field to force a specific transport
 
 Configuration Options:
  - command: Executable command for stdio transport
  - args: Command line arguments array
  - env: Environment variables object (stdio only) - merged with process.env
  - url: Remote server URL for http/sse/stream transports
  - type: Explicit transport type (optional)
 
 Examples:
  node index.ts --config ./config.json
  node index.ts --config ./config.json --port 3006 --debug
  node index.ts -c ./config.json --healthEndpoint /healthz --healthEndpoint /readyz
 
 Connection endpoints:
  - Primary: http://localhost:3006/mcp (with automatic fallback)
  - Legacy SSE: http://localhost:3006/sse (explicit SSE endpoint)
  - Legacy messages: http://localhost:3006/messages (message posting)
 `);
  process.exit(0);
}

// Only run main if not in help mode
if (!process.argv.includes("--help") && !process.argv.includes("-h")) {
  main().catch((error) => {
    console.error("Failed to start MCP SuperAssistant Proxy:", error);
    process.exit(1);
  });
}