# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.19] - 2025-06-08

### Added
- **Parallel Server Initialization**
  - Servers now connect in parallel instead of sequentially
  - Configurable batch size with `--maxConcurrentServerConnections` option
  - Progress tracking with real-time connection status updates
  - Significant performance improvement for configs with many servers

### Fixed
- **Race Conditions in Connection Process**
  - Thread-safe result collection using Promise.allSettled
  - Atomic counter for progress tracking
  - Proper synchronization of success/failure arrays
  - Eliminated potential data loss in concurrent operations

### Enhanced
- **Input Validation**
  - Robust validation for maxConcurrentServerConnections parameter
  - Handles negative numbers, zero, and non-integers gracefully
  - Automatically uses sensible defaults for invalid inputs
  - Prevents potential infinite loops from bad configuration

### Performance
- **Startup Time Improvements**
  - 50%+ reduction in initialization time for multiple servers
  - Example: 6 servers reduced from ~20 seconds to ~10 seconds
  - Scales better with large numbers of MCP servers
  - No impact on individual server connection reliability

## [0.0.18] - 2025-06-07

### Added
- **Advanced Concurrent Request Control**
  - Configurable per-session concurrent request limits (default: 10)
  - HTTP 429 responses when concurrent limit exceeded
  - Request lifecycle tracking with automatic counter management
  - New CLI option: `--maxConcurrentRequestsPerSession <number>`

### Enhanced
- **Intelligent Session Management**
  - Extended session timeout from 2 to 5 minutes for better stability
  - Smart activity tracking with `lastActivity` timestamps
  - Safe cleanup mechanism that preserves sessions with active requests
  - Improved session initialization with correct active request counting

### Improved
- **Streamable HTTP Transport Stability**
  - Unified concurrent control across POST, GET, and DELETE endpoints
  - Enhanced error logging with detailed debug information
  - Better request completion tracking in try/finally blocks
  - Consistent session validation across all HTTP methods

### Fixed
- **Session Lifecycle Issues**
  - Session initialization now correctly starts with activeRequests = 1
  - Fixed potential race conditions in concurrent request tracking
  - Improved session cleanup safety checks
  - Better error handling for session termination

### Technical
- **Code Quality Improvements**
  - Comprehensive test coverage with 30 passing tests
  - Enhanced debugging capabilities with detailed request logging
  - Configurable parameters moved from hardcoded to options
  - Memory usage optimization through better session data structure

## [0.0.17] - 2025-06-07

### Fixed
- **Critical**: Fixed SSE sessions not being released when browser tabs are closed
  - Enhanced socket status detection before sending keep-alive
  - Improved cleanup mechanism with socket.destroy() when needed
  - Better detection of dead connections through write failures
- Improved error categorization system (transient vs critical errors)
  - Only cleanup on critical errors or after 5+ accumulated errors
  - Prevents premature disconnection on transient network issues

### Changed
- **Performance Improvements**
  - Reduced keep-alive interval from 30s to 15s for faster dead connection detection
  - Reduced cleanup check interval from 30s to 10s
  - Reduced stale session threshold from 5 minutes to 2 minutes
  - Added 1-minute threshold for dead connection detection
- **Enhanced Connection State Tracking**
  - Added connectionState field (active/closed/error)
  - Added errorCount tracking
  - Added keepAliveSuccess counter
  - Improved session cleanup logging
- **Simplified Implementation**
  - Removed unnecessary SSE retry mechanism
  - Removed unused clientInfo and lastError tracking
  - Removed TCP_NODELAY setting (not beneficial for SSE)

### Improved
- Socket configuration now uses 15s TCP keep-alive probes (was 30s)
- Keep-alive mechanism now checks socket writability before sending
- Cleanup functions now properly destroy underlying sockets
- Better handling of concurrent cleanup events

## [0.0.16] - 2025-06-07

### Added
- **SSE Connection Stability Improvements**
  - Implemented keep-alive mechanism sending heartbeat every 30 seconds
  - Added TCP socket keep-alive with 30-second probe interval
  - Added Keep-Alive HTTP header with 5-minute timeout
  - Track session creation time and last activity timestamp
  - Automatic cleanup of inactive SSE sessions after 5 minutes
  - SSE connection retry mechanism with exponential backoff (up to 3 retries)
- **Comprehensive tests for SSE stability features**
  - Keep-alive mechanism tests
  - Activity tracking tests
  - Retry mechanism tests
  - Stale session cleanup tests

### Fixed
- SSE connections dropping after being idle
- Connection instability issues reported by users
- Memory leaks from uncleaned keep-alive intervals

### Changed
- Enhanced SSE transport error handling with better cleanup
- Improved resource cleanup on connection failures
- Better logging for SSE session lifecycle

## [0.0.15] - 2025-06-07

### Fixed
- **Critical**: Fixed missing main() function call that prevented the proxy from starting
- Fixed TypeScript compilation output directory structure

### Changed
- Improved error handling and logging for startup failures

## [0.0.14] - 2025-06-07

### Added
- Comprehensive test suite for v0.0.12 memory leak fixes
- Jest testing framework configuration
- Tests for session management and limits
- Tests for memory leak prevention
- Tests for resource cleanup on connection failure

### Changed
- Updated tsconfig.json to support test files

## [0.0.13] - 2025-06-07

### Changed
- Updated package name to @yulin0629/mcp-superassistant-proxy
- Added proper attribution to original author @srbhptl39
- Added repository, homepage, and bugs URLs to package.json
- Updated README to reflect fork origin and new package name

### Added
- Author information in package.json
- Fork note in README acknowledging original npm package

## [0.0.12] - 2025-06-07

### Fixed
- **Critical**: Fixed memory leak that caused the proxy to become unresponsive after running for a while
  - Re-enabled automatic cleanup of stale Streamable HTTP sessions
  - Reduced cleanup interval from 2 minutes to 30 seconds
  - Reduced stale session threshold from 5 minutes to 2 minutes
- Improved resource cleanup on connection failures
  - Now properly cleans up client resources when transport connection fails
  - Cleans up sessions immediately when server.connect() fails
- Fixed potential resource leaks in SSE session cleanup
  - Now cleans up both transport and server instances

### Added
- Session limit protection to prevent resource exhaustion
  - Streamable HTTP sessions limited to 100 concurrent connections
  - SSE sessions limited to 50 concurrent connections
  - Returns 503 Service Unavailable when limits are reached
- Active session monitoring
  - Logs active session count during cleanup cycles (with info log level)
  - Better visibility into session lifecycle

### Changed
- Improved session cleanup logic with better error handling
- Enhanced logging for session management operations

## [0.0.11] - Previous version
- Initial release with multi-transport support

[0.0.17]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.14...v0.0.15
[0.0.14]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.11...v0.0.12