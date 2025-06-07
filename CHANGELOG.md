# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.13]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/yulin0629/mcp-sse-proxy/compare/v0.0.11...v0.0.12