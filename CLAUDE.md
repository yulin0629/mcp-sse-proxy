# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MCP SuperAssistant Proxy is a TypeScript application that acts as a proxy server for the Model Context Protocol (MCP). It allows multiple MCP servers (both stdio-based and SSE-based) to be exposed through a single endpoint, supporting backwards compatibility between different MCP transport protocols.

**Current Version**: v0.0.16 (@yulin0629/mcp-superassistant-proxy)
- Fork of the original @srbhptl39/mcp-superassistant-proxy package
- Supports both modern Streamable HTTP (protocol 2025-03-26) and legacy SSE (protocol 2024-11-05)

## Common Development Tasks

### Build Commands
```bash
# Build TypeScript to JavaScript
npm run build

# Start the built application
npm run start
```

### Running the Proxy
```bash
# Run directly with npx
npx -y @yulin0629/mcp-superassistant-proxy@latest --config path/to/config.json

# Run from source
npm run build && node dist/index.js --config config.json --port 3006
```

## Architecture

### Core Components

1. **MCPSuperAssistantProxy Class** (src/index.ts:95)
   - Main proxy orchestrator that manages connections to multiple MCP servers
   - Handles both modern Streamable HTTP and legacy SSE transports
   - Manages session lifecycles and cleanup

2. **Transport Management**
   - **Streamable HTTP**: Modern transport (protocol version 2025-03-26) at `/mcp` endpoint
   - **SSE (Server-Sent Events)**: Legacy transport (protocol version 2024-11-05) at `/sse` endpoint
   - Automatic backwards compatibility: tries Streamable HTTP first, falls back to SSE

3. **Server Connection Types**
   - **stdio**: Local MCP servers run as child processes
   - **http**: Remote servers with automatic transport fallback
   - **sse**: Explicit SSE transport
   - **stream**: Explicit Streamable HTTP transport

### Key Design Patterns

1. **Session Management**
   - Each client connection gets a unique session ID
   - Sessions are tracked separately for Streamable HTTP and SSE transports
   - Automatic cleanup of stale sessions

2. **Request Delegation**
   - Tool names are prefixed with server name (e.g., `serverName.toolName`)
   - Resources use custom URI scheme: `serverName://resource-uri`
   - Prompts follow same naming convention as tools

3. **Error Handling**
   - Graceful degradation when servers fail to connect
   - Network error formatting for better debugging
   - Timeout handling for all async operations

4. **Process Management**
   - Child processes for stdio servers are tracked and terminated gracefully
   - Proper signal handling (SIGTERM, SIGKILL) during shutdown
   - Prevents orphaned processes

## Configuration

The proxy requires a JSON configuration file specifying MCP servers:

```json
{
  "mcpServers": {
    "serverName": {
      "command": "npx",           // For stdio servers
      "args": ["package-name"],
      "env": { "KEY": "value" }   // Optional environment variables
    },
    "remoteServer": {
      "url": "http://example.com/mcp",  // For HTTP servers
      "type": "http"                    // Optional, auto-inferred
    }
  }
}
```

## Important Implementation Details

- Transport type is auto-inferred if not specified (command → stdio, url → http)
- Environment variables in stdio configs are merged with process.env
- All server handlers are copied to session-specific server instances
- CORS is enabled by default for browser compatibility
- Health endpoints can be configured for monitoring
- Session limits: 100 for Streamable HTTP, 50 for SSE
- Automatic cleanup of stale sessions every 30 seconds
- SSE connections have keep-alive mechanism (30-second heartbeats)

## Testing

Run the test suite to verify functionality:
```bash
npm test
```

Tests cover:
- Session management and limits
- Memory leak prevention
- Resource cleanup
- Protocol fallback mechanisms


# PS
修正問題時，請盡量修改原檔案，而不是開新檔案。

## Deployment Process

- 發版的順序是 **新增和修正** readme package.json claude.md and changelog(最後) >  github > npm