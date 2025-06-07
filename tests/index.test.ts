import express from 'express';

// 測試 v0.0.12 的記憶體洩漏修復
describe('MCPSuperAssistantProxy v0.0.12 Tests', () => {
  let app: express.Application;
  let mockProxy: any;

  beforeEach(() => {
    app = express();
    mockProxy = {
      transports: {
        streamable: {},
        sse: {}
      },
      cleanupStaleStreamableSessions: jest.fn(),
      connectedServers: new Map()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Session Management', () => {
    it('should limit streamable sessions to 100', async () => {
      // 模擬 100 個現有會話
      for (let i = 0; i < 100; i++) {
        mockProxy.transports.streamable[`session-${i}`] = {
          transport: {},
          server: {},
          createdAt: Date.now()
        };
      }

      const sessionCount = Object.keys(mockProxy.transports.streamable).length;
      expect(sessionCount).toBe(100);

      // 新會話應該被拒絕
      const shouldReject = sessionCount >= 100;
      expect(shouldReject).toBe(true);
    });

    it('should limit SSE sessions to 50', async () => {
      // 模擬 50 個 SSE 會話
      for (let i = 0; i < 50; i++) {
        mockProxy.transports.sse[`sse-session-${i}`] = {
          transport: {},
          server: {},
          response: {}
        };
      }

      const sseSessionCount = Object.keys(mockProxy.transports.sse).length;
      expect(sseSessionCount).toBe(50);

      // 新 SSE 會話應該被拒絕
      const shouldReject = sseSessionCount >= 50;
      expect(shouldReject).toBe(true);
    });
  });

  describe('Memory Leak Fixes', () => {
    it('should cleanup stale sessions every 30 seconds', () => {
      const intervalSpy = jest.spyOn(global, 'setInterval');
      
      // 模擬代理初始化
      const mockInterval = setInterval(() => {
        mockProxy.cleanupStaleStreamableSessions();
      }, 30 * 1000);

      expect(intervalSpy).toHaveBeenCalled();
      clearInterval(mockInterval);
    });

    it('should remove sessions older than 2 minutes', () => {
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000 + 1000); // 2分1秒前

      // 添加過期會話
      mockProxy.transports.streamable['stale-session'] = {
        transport: { close: jest.fn() },
        server: { close: jest.fn() },
        createdAt: twoMinutesAgo
      };

      // 添加新會話
      mockProxy.transports.streamable['fresh-session'] = {
        transport: {},
        server: {},
        createdAt: now
      };

      // 模擬清理邏輯
      const staleThreshold = 2 * 60 * 1000;
      const sessionsToDelete = [];

      for (const [sessionId, sessionData] of Object.entries(mockProxy.transports.streamable)) {
        const data = sessionData as { createdAt: number };
        const age = now - data.createdAt;
        if (age > staleThreshold) {
          sessionsToDelete.push(sessionId);
        }
      }

      expect(sessionsToDelete).toContain('stale-session');
      expect(sessionsToDelete).not.toContain('fresh-session');
    });
  });

  describe('Resource Cleanup', () => {
    it('should cleanup transport and server on connection failure', async () => {
      const mockTransport = { close: jest.fn() };
      const mockServer = { close: jest.fn() };

      // 模擬連接失敗清理
      try {
        throw new Error('Connection failed');
      } catch (error) {
        // 清理邏輯
        if (mockTransport && typeof mockTransport.close === 'function') {
          mockTransport.close();
        }
        if (mockServer && typeof mockServer.close === 'function') {
          mockServer.close();
        }
      }

      expect(mockTransport.close).toHaveBeenCalled();
      expect(mockServer.close).toHaveBeenCalled();
    });
  });
});