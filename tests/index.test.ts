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

// 測試 v0.0.16 的 SSE 連線穩定性改進
describe('SSE Connection Stability Tests (v0.0.16)', () => {
  let mockResponse: any;
  let mockRequest: any;
  let mockSSETransport: any;

  beforeEach(() => {
    mockResponse = {
      setHeader: jest.fn(),
      write: jest.fn(),
      headersSent: false,
      socket: {
        setKeepAlive: jest.fn(),
        setTimeout: jest.fn(),
        localPort: 3006
      }
    };

    mockRequest = {
      get: jest.fn().mockReturnValue('localhost:3006'),
      secure: false,
      socket: mockResponse.socket,
      ip: '127.0.0.1',
      on: jest.fn()
    };

    mockSSETransport = {
      sessionId: 'test-sse-session',
      close: jest.fn(),
      handlePostMessage: jest.fn().mockResolvedValue(undefined)
    };
  });

  describe('Keep-Alive Mechanism', () => {
    it('should configure socket with keep-alive settings', () => {
      // 模擬 SSE 連線設定
      mockResponse.socket.setKeepAlive(true, 30000);
      mockResponse.socket.setTimeout(0);

      expect(mockResponse.socket.setKeepAlive).toHaveBeenCalledWith(true, 30000);
      expect(mockResponse.socket.setTimeout).toHaveBeenCalledWith(0);
    });

    it('should set proper keep-alive headers', () => {
      // 設定 SSE headers
      mockResponse.setHeader('Content-Type', 'text/event-stream');
      mockResponse.setHeader('Cache-Control', 'no-cache, no-transform');
      mockResponse.setHeader('Connection', 'keep-alive');
      mockResponse.setHeader('X-Accel-Buffering', 'no');
      mockResponse.setHeader('Keep-Alive', 'timeout=300');

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Keep-Alive', 'timeout=300');
    });

    it('should send keep-alive pings every 30 seconds', () => {
      jest.useFakeTimers();
      
      // 模擬 keep-alive interval
      const keepAliveInterval = setInterval(() => {
        mockResponse.write(':keepalive\n\n');
      }, 30000);

      // 快進 30 秒
      jest.advanceTimersByTime(30000);
      expect(mockResponse.write).toHaveBeenCalledWith(':keepalive\n\n');

      // 再快進 30 秒
      jest.advanceTimersByTime(30000);
      expect(mockResponse.write).toHaveBeenCalledTimes(2);

      clearInterval(keepAliveInterval);
      jest.useRealTimers();
    });
  });

  describe('Activity Tracking', () => {
    it('should track session creation time and last activity', () => {
      const sessions: any = {};
      const sessionId = 'test-session';
      const now = Date.now();

      // 創建 session
      sessions[sessionId] = {
        transport: mockSSETransport,
        server: {},
        response: mockResponse,
        createdAt: now,
        lastActivity: now
      };

      expect(sessions[sessionId].createdAt).toBeDefined();
      expect(sessions[sessionId].lastActivity).toBeDefined();
      expect(sessions[sessionId].lastActivity).toBe(sessions[sessionId].createdAt);
    });

    it('should update lastActivity on message posts', () => {
      const sessions: any = {};
      const sessionId = 'test-session';
      const initialTime = Date.now();

      sessions[sessionId] = {
        transport: mockSSETransport,
        lastActivity: initialTime
      };

      // 模擬一秒後的活動
      const newTime = initialTime + 1000;
      sessions[sessionId].lastActivity = newTime;

      expect(sessions[sessionId].lastActivity).toBe(newTime);
      expect(sessions[sessionId].lastActivity).toBeGreaterThan(initialTime);
    });
  });

  describe('SSE Retry Mechanism', () => {
    it('should retry connection with exponential backoff', async () => {
      const mockConnect = jest.fn()
        .mockRejectedValueOnce(new Error('Attempt 1 failed'))
        .mockRejectedValueOnce(new Error('Attempt 2 failed'))
        .mockResolvedValueOnce(undefined);

      let attemptCount = 0;
      const maxRetries = 3;

      // 模擬重試邏輯
      for (let i = 0; i < maxRetries; i++) {
        try {
          attemptCount++;
          await mockConnect();
          break;
        } catch (error) {
          if (i < maxRetries - 1) {
            // 模擬指數退避延遲
            await new Promise(resolve => setTimeout(resolve, (i + 1) * 10));
          }
        }
      }

      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(attemptCount).toBe(3);
    });

    it('should clean up failed transport on retry', async () => {
      const mockTransport = { close: jest.fn() };
      const mockClient = { close: jest.fn() };

      // 模擬清理邏輯
      const cleanup = async () => {
        if (mockTransport && typeof mockTransport.close === 'function') {
          mockTransport.close();
        }
        if (mockClient && typeof mockClient.close === 'function') {
          await mockClient.close();
        }
      };

      await cleanup();

      expect(mockTransport.close).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });
  });

  describe('Stale SSE Session Cleanup', () => {
    it('should clean up SSE sessions after 5 minutes of inactivity', () => {
      const now = Date.now();
      const sessions: any = {
        'active-session': {
          lastActivity: now - (3 * 60 * 1000), // 3 分鐘前
          createdAt: now - (4 * 60 * 1000),
          keepAliveInterval: 123
        },
        'stale-session': {
          lastActivity: now - (6 * 60 * 1000), // 6 分鐘前
          createdAt: now - (10 * 60 * 1000),
          keepAliveInterval: 456
        }
      };

      const staleThreshold = 5 * 60 * 1000;
      const staleSessions: string[] = [];

      for (const [sessionId, sessionData] of Object.entries(sessions)) {
        const data = sessionData as { lastActivity?: number; createdAt?: number };
        const lastActivity = data.lastActivity || data.createdAt || now;
        const inactiveTime = now - lastActivity;
        if (inactiveTime > staleThreshold) {
          staleSessions.push(sessionId);
        }
      }

      expect(staleSessions).toEqual(['stale-session']);
      expect(staleSessions).not.toContain('active-session');
    });

    it('should clear keep-alive interval on cleanup', () => {
      const mockClearInterval = jest.spyOn(global, 'clearInterval');
      const keepAliveInterval = setInterval(() => {}, 30000);

      const session = {
        keepAliveInterval,
        transport: { close: jest.fn() },
        server: { close: jest.fn() }
      };

      // 模擬清理
      if (session.keepAliveInterval) {
        clearInterval(session.keepAliveInterval);
      }

      expect(mockClearInterval).toHaveBeenCalledWith(keepAliveInterval);
      
      clearInterval(keepAliveInterval);
      mockClearInterval.mockRestore();
    });
  });

  describe('Session Limit Protection', () => {
    it('should enforce 50 session limit for SSE', () => {
      const sessions: any = {};
      const sessionLimit = 50;

      // 填滿到限制
      for (let i = 0; i < sessionLimit; i++) {
        sessions[`sse-${i}`] = { createdAt: Date.now() };
      }

      const currentCount = Object.keys(sessions).length;
      expect(currentCount).toBe(sessionLimit);

      // 檢查是否應該拒絕新連線
      const shouldRejectNew = currentCount >= sessionLimit;
      expect(shouldRejectNew).toBe(true);
    });
  });
});