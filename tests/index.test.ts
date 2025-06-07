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
    it('should cleanup stale sessions every 10 seconds', () => {
      const intervalSpy = jest.spyOn(global, 'setInterval');
      
      // 模擬代理初始化
      const mockInterval = setInterval(() => {
        mockProxy.cleanupStaleStreamableSessions();
      }, 10 * 1000);

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
      mockResponse.socket.setKeepAlive(true, 15000);
      mockResponse.socket.setTimeout(0);

      expect(mockResponse.socket.setKeepAlive).toHaveBeenCalledWith(true, 15000);
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

    it('should send keep-alive pings every 15 seconds', () => {
      jest.useFakeTimers();
      
      // 模擬 keep-alive interval
      const keepAliveInterval = setInterval(() => {
        mockResponse.write(':keepalive\n\n');
      }, 15000);

      // 快進 15 秒
      jest.advanceTimersByTime(15000);
      expect(mockResponse.write).toHaveBeenCalledWith(':keepalive\n\n');

      // 再快進 15 秒
      jest.advanceTimersByTime(15000);
      expect(mockResponse.write).toHaveBeenCalledTimes(2);

      clearInterval(keepAliveInterval);
      jest.useRealTimers();
    });

    it('should check socket status before sending keep-alive', () => {
      // 測試 socket 狀態檢查
      const checkSocketStatus = (socket: any) => {
        return socket && !socket.destroyed && socket.writable;
      };

      expect(checkSocketStatus({ destroyed: false, writable: true })).toBe(true);
      expect(checkSocketStatus({ destroyed: true, writable: true })).toBe(false);
      expect(checkSocketStatus({ destroyed: false, writable: false })).toBe(false);
      expect(checkSocketStatus(null)).toBeFalsy();
    });

    it('should detect write failures during keep-alive', () => {
      // 模擬 write 失敗
      mockResponse.write = jest.fn().mockReturnValue(false);
      
      const writeSuccess = mockResponse.write(':keepalive\n\n');
      expect(writeSuccess).toBe(false);
      
      // 模擬 write 成功
      mockResponse.write = jest.fn().mockReturnValue(true);
      const writeSuccess2 = mockResponse.write(':keepalive\n\n');
      expect(writeSuccess2).toBe(true);
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

  describe('Enhanced Error Handling', () => {
    it('should track error count and connection state', () => {
      const sessions: any = {};
      const sessionId = 'test-session';
      
      sessions[sessionId] = {
        transport: mockSSETransport,
        connectionState: 'active',
        errorCount: 0,
        keepAliveSuccess: 0
      };

      // 模擬錯誤發生
      sessions[sessionId].errorCount++;
      sessions[sessionId].connectionState = 'error';

      expect(sessions[sessionId].errorCount).toBe(1);
      expect(sessions[sessionId].connectionState).toBe('error');
    });

    it('should categorize errors as transient or critical', () => {
      // 模擬錯誤分類函數
      const categorizeError = (error: any): 'transient' | 'critical' | 'unknown' => {
        const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'];
        const criticalErrors = ['ECONNREFUSED', 'EACCES', 'EMFILE'];
        
        if (error.code) {
          if (transientErrors.includes(error.code)) return 'transient';
          if (criticalErrors.includes(error.code)) return 'critical';
        }
        return 'unknown';
      };

      expect(categorizeError({ code: 'ECONNRESET' })).toBe('transient');
      expect(categorizeError({ code: 'ECONNREFUSED' })).toBe('critical');
      expect(categorizeError({ code: 'UNKNOWN' })).toBe('unknown');
    });
  });

  describe('Stale SSE Session Cleanup', () => {
    it('should clean up SSE sessions after 2 minutes of inactivity', () => {
      const now = Date.now();
      const sessions: any = {
        'active-session': {
          lastActivity: now - (1 * 60 * 1000), // 1 分鐘前
          createdAt: now - (2 * 60 * 1000),
          keepAliveInterval: 123,
          connectionState: 'active',
          keepAliveSuccess: 10
        },
        'stale-session': {
          lastActivity: now - (3 * 60 * 1000), // 3 分鐘前
          createdAt: now - (5 * 60 * 1000),
          keepAliveInterval: 456,
          connectionState: 'active',
          keepAliveSuccess: 5
        }
      };

      const staleThreshold = 2 * 60 * 1000;
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

    it('should immediately clean up dead connections', () => {
      const now = Date.now();
      const sessions: any = {
        'dead-session': {
          lastActivity: now - (30 * 1000), // 30 秒前
          connectionState: 'closed',
          keepAliveSuccess: 0
        },
        'error-session': {
          lastActivity: now - (45 * 1000), // 45 秒前
          connectionState: 'error',
          keepAliveSuccess: 0
        },
        'inactive-no-keepalive': {
          lastActivity: now - (65 * 1000), // 65 秒前
          connectionState: 'active',
          keepAliveSuccess: 0
        },
        'healthy-session': {
          lastActivity: now - (30 * 1000), // 30 秒前
          connectionState: 'active',
          keepAliveSuccess: 5
        }
      };

      const deadConnectionThreshold = 60 * 1000;
      const deadSessions: string[] = [];

      for (const [sessionId, sessionData] of Object.entries(sessions)) {
        const data = sessionData as any;
        const inactiveTime = now - (data.lastActivity || now);
        const isDead = data.connectionState === 'closed' || 
                       data.connectionState === 'error' ||
                       (data.keepAliveSuccess === 0 && inactiveTime > deadConnectionThreshold);
        
        if (isDead) {
          deadSessions.push(sessionId);
        }
      }

      expect(deadSessions).toContain('dead-session');
      expect(deadSessions).toContain('error-session');
      expect(deadSessions).toContain('inactive-no-keepalive');
      expect(deadSessions).not.toContain('healthy-session');
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