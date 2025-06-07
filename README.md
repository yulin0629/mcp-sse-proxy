# MCP SuperAssistant Proxy

> **Fork Note**: This is an enhanced fork based on the original npm package [@srbhptl39/mcp-superassistant-proxy](https://www.npmjs.com/package/@srbhptl39/mcp-superassistant-proxy) with improved memory management, session limits, and comprehensive test coverage.

MCP SuperAssistant Proxy lets you run multiple **MCP stdio-based** and **SSE-based** servers and expose them through a single SSE endpoint. This allows MCP SuperAssistant and other tools to connect to multiple remote MCP servers and tools via a unified proxy.

## Version 0.0.12

### Important Fix
This version fixes a critical memory leak that caused the proxy to become unresponsive after running for a while. If you're experiencing connection issues with older versions, please upgrade immediately.

## Installation & Usage

Run MCP SuperAssistant Proxy via `npx`:

```bash
npx -y @yulin0629/mcp-superassistant-proxy@latest --config path/to/config.json
```

### CLI Options

- `--config, -c <path>`: **(required)** Path to a JSON configuration file (see below)
- `--port <number>`: Port to run the proxy server on (default: `3006`)
- `--baseUrl <url>`: Base URL for SSE clients (default: `http://localhost:<port>`)
- `--ssePath <path>`: Path for SSE subscriptions (default: `/sse`)
- `--messagePath <path>`: Path for SSE messages (default: `/message`)
- `--logLevel <info|none>`: Set logging level (default: `info`)
- `--cors`: Enable CORS (default: `true`)
- `--healthEndpoint <path>`: One or more endpoints returning `"ok"` (can be used multiple times)
- `--timeout <ms>`: Connection timeout in milliseconds (default: `30000`)

## Configuration File

The configuration file is a JSON file specifying which MCP servers to connect to. Each server can be either a stdio-based server (run as a subprocess) or an SSE-based server (remote URL).

### Example `config.json`

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@suekou/mcp-notion-server"],
      "env": {
        "NOTION_API_TOKEN": "<your_notion_token_here>"
      }
    },
    "gmail": {
      "url": "https://mcp.composio.dev/gmail/xxxx"
    },
    "youtube-subtitle-downloader": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/mcp-youtube/src/index.ts"
      ]
    },
    "desktop-commander": {
      "command": "npx",
      "args": ["-y", "@wonderwhy-er/desktop-commander"]
    },
    "iterm-mcp": {
      "command": "npx",
      "args": ["-y", "iterm-mcp"]
    }
  }
}
```

- Each key under `mcpServers` is a unique name for the server.
- For stdio-based servers, specify `command`, `args`, and optionally `env`.
- For SSE-based servers, specify `url`.

## Endpoints

Once started, the proxy exposes:
- **SSE endpoint**: `GET http://localhost:<port>/sse`
- **POST messages**: `POST http://localhost:<port>/message`

(You can customize the paths with `--ssePath` and `--messagePath`.)

## Example

1. **Create a config file** (e.g., `config.json`) as shown above.
2. **Run MCP SuperAssistant Proxy**:
   ```bash
   npx -y @srbhptl39/mcp-superassistant-proxy@latest --config config.json --port 3006
   ```

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes how AI tools exchange data. If your MCP server only speaks stdio, MCP SuperAssistant Proxy exposes an SSE-based interface so remote clients (and tools like MCP Inspector or Claude Desktop) can connect without extra server changes. It also allows you to aggregate multiple MCP servers behind a single endpoint.

## Advanced Configuration

MCP SuperAssistant Proxy is designed with modularity in mind:
- Supports both stdio and SSE MCP servers in one config.
- Automatically derives the JSON‑RPC version from incoming requests, ensuring future compatibility.
- Package information (name and version) is retransmitted where possible.
- Stdio-to-SSE mode uses standard logs and SSE-to-Stdio mode logs via stderr (as otherwise it would prevent stdio functionality).
- The SSE-to-SSE mode provides automatic reconnection with backoff if the remote server connection is lost.
- Health endpoints can be added for monitoring.
- Session management with automatic cleanup of stale connections (2-minute timeout).
- Connection limits to prevent resource exhaustion (100 Streamable HTTP sessions, 50 SSE sessions).

---

For more details, see the [Model Context Protocol documentation](https://modelcontextprotocol.io/).

