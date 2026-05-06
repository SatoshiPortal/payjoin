import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { Socket } from 'net';

import { setupGracefulShutdown } from './gracefulShutdown';

// Mock logger that also prints to console for visibility
const createMockLogger = () => ({
  debug: jest.fn((msg: string, ...args: any[]) => console.log('[DEBUG]', msg, ...args)),
  info: jest.fn((msg: string, ...args: any[]) => console.log('[INFO]', msg, ...args)),
  warn: jest.fn((msg: string, ...args: any[]) => console.log('[WARN]', msg, ...args)),
  error: jest.fn((msg: string, ...args: any[]) => console.log('[ERROR]', msg, ...args)),
});

// Mock socket with _httpMessage property
const createMockSocket = (hasActiveRequest = false): Socket & { _httpMessage?: any } => {
  const socket = new EventEmitter() as Socket & { _httpMessage?: any };
  (socket as any).destroy = jest.fn();
  if (hasActiveRequest) {
    socket._httpMessage = {}; // Simulates an active HTTP request
  }
  return socket;
};

// Mock server
const createMockServer = (): Server & EventEmitter => {
  const server = new EventEmitter() as Server & EventEmitter;
  server.close = jest.fn((callback?: (err?: Error) => void) => {
    if (callback) callback();
    return server;
  });
  return server;
};

describe('gracefulShutdown', () => {
  let mockServer: Server & EventEmitter;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let originalListeners: NodeJS.SignalsListener[];
  let originalExit: typeof process.exit;

  beforeEach(() => {
    jest.useFakeTimers();
    mockServer = createMockServer();
    mockLogger = createMockLogger();

    // Save original SIGTERM listeners and process.exit
    originalListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
    originalExit = process.exit;

    // Remove all existing SIGTERM/SIGINT listeners for clean tests
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    // Mock process.exit
    process.exit = jest.fn() as any;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();

    // Restore original listeners and process.exit
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    originalListeners.forEach((listener) => process.on('SIGTERM', listener));
    process.exit = originalExit;
  });

  describe('initialization', () => {
    it('should remove existing SIGTERM listeners and register new handlers', () => {
      // Add a dummy listener to simulate tsx/esbuild handler
      const dummyListener = jest.fn();
      process.on('SIGTERM', dummyListener);

      setupGracefulShutdown(mockServer, mockLogger);

      // Should have logged removal of the dummy listener
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Removed 1 existing SIGTERM listener(s)')
      );

      // Should have registered new handlers
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Registered SIGTERM and SIGINT handlers')
      );
    });

    it('should return isShuttingDown and trackTask functions', () => {
      const result = setupGracefulShutdown(mockServer, mockLogger);

      expect(typeof result.isShuttingDown).toBe('function');
      expect(typeof result.trackTask).toBe('function');
      expect(result.isShuttingDown()).toBe(false);
    });
  });

  describe('Case 1: shutdown triggered without requests or tasks', () => {
    it('should close server immediately and exit with code 0', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      // Trigger SIGTERM
      process.emit('SIGTERM');

      // Should call server.close
      expect(mockServer.close).toHaveBeenCalled();

      // Should exit with code 0 (via callback)
      expect(process.exit).toHaveBeenCalledWith(0);

      // Should log shutdown sequence
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SIGTERM received. Starting graceful shutdown')
      );
    });

    it('should work with SIGINT as well', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      process.emit('SIGINT');

      expect(mockServer.close).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SIGINT received')
      );
    });
  });

  describe('Case 2: shutdown triggered with requests in progress, no tasks', () => {
    it('should keep active connections and wait for them to complete', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      // Simulate an active connection with an ongoing request
      const activeSocket = createMockSocket(true);
      mockServer.emit('connection', activeSocket);

      // Simulate an idle connection
      const idleSocket = createMockSocket(false);
      mockServer.emit('connection', idleSocket);

      // Trigger shutdown
      process.emit('SIGTERM');

      // Idle connection should be destroyed
      expect(idleSocket.destroy).toHaveBeenCalled();

      // Active connection should NOT be destroyed
      expect(activeSocket.destroy).not.toHaveBeenCalled();

      // Should log the connection handling
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Closed 1 idle connection(s), keeping 1 active connection(s)')
      );
    });

    it('should wait for server.close callback before exiting', async () => {
      let closeCallback: ((err?: Error) => void) | undefined;

      mockServer.close = jest.fn((callback?: (err?: Error) => void) => {
        closeCallback = callback;
        return mockServer;
      });

      setupGracefulShutdown(mockServer, mockLogger);

      const activeSocket = createMockSocket(true);
      mockServer.emit('connection', activeSocket);

      process.emit('SIGTERM');

      // Should not have exited yet (waiting for requests to complete)
      expect(process.exit).not.toHaveBeenCalledWith(0);

      // Simulate request completion - socket closes
      activeSocket.emit('close');

      // Now call the close callback to simulate server fully closed
      closeCallback?.();

      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('Case 3: shutdown triggered with tasks in progress, no requests', () => {
    it('should wait for active tasks to complete before closing server', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      let taskResolver: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        taskResolver = resolve;
      });

      // Start a task (don't await it yet)
      const trackedTask = trackTask('testTask', () => taskPromise);

      // Trigger shutdown while task is running
      process.emit('SIGTERM');

      // Should log waiting for tasks
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Waiting for 1 active task(s) to complete')
      );

      // Complete the task
      taskResolver!();
      await trackedTask;

      // Allow promises to settle
      await Promise.resolve();

      // Should log that tasks completed
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('All background tasks completed')
      );
    });

    it('should wait for multiple tasks to complete', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      let task1Resolver: () => void;
      let task2Resolver: () => void;

      const task1Promise = new Promise<void>((resolve) => {
        task1Resolver = resolve;
      });
      const task2Promise = new Promise<void>((resolve) => {
        task2Resolver = resolve;
      });

      const tracked1 = trackTask('task1', () => task1Promise);
      const tracked2 = trackTask('task2', () => task2Promise);

      process.emit('SIGTERM');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Waiting for 2 active task(s) to complete')
      );

      // Complete tasks
      task1Resolver!();
      task2Resolver!();
      await Promise.all([tracked1, tracked2]);
    });
  });

  describe('Case 4: shutdown triggered with both requests and tasks in progress', () => {
    it('should wait for tasks first, then wait for requests', async () => {
      let closeCallback: ((err?: Error) => void) | undefined;

      mockServer.close = jest.fn((callback?: (err?: Error) => void) => {
        closeCallback = callback;
        return mockServer;
      });

      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      // Start a task
      let taskResolver: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        taskResolver = resolve;
      });
      const trackedTask = trackTask('backgroundJob', () => taskPromise);

      // Simulate an active connection
      const activeSocket = createMockSocket(true);
      mockServer.emit('connection', activeSocket);

      // Trigger shutdown
      process.emit('SIGTERM');

      // Should be waiting for tasks
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Waiting for 1 active task(s) to complete')
      );

      // Complete the task
      taskResolver!();
      await trackedTask;
      await Promise.resolve();

      // Now server.close should have been called
      expect(mockServer.close).toHaveBeenCalled();

      // Active connection should be kept
      expect(activeSocket.destroy).not.toHaveBeenCalled();

      // Simulate request completion
      activeSocket.emit('close');
      closeCallback?.();

      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('Case 5: duplicate shutdown signal', () => {
    it('should ignore duplicate SIGTERM signals', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      // First signal
      process.emit('SIGTERM');

      // Second signal
      process.emit('SIGTERM');

      // Should log ignoring duplicate
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring duplicate SIGTERM signal')
      );

      // server.close should only be called once
      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });

    it('should ignore SIGINT after SIGTERM', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      process.emit('SIGTERM');
      process.emit('SIGINT');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring duplicate SIGINT signal')
      );

      expect(mockServer.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Case 6: trackTask called during shutdown', () => {
    it('should throw error when trying to start a task during shutdown', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      // Trigger shutdown
      process.emit('SIGTERM');

      // Try to start a new task
      await expect(
        trackTask('newTask', async () => 'result')
      ).rejects.toThrow('Cannot start task "newTask" - server is shutting down');
    });

    it('should allow checking isShuttingDown status', () => {
      const { isShuttingDown } = setupGracefulShutdown(mockServer, mockLogger);

      expect(isShuttingDown()).toBe(false);

      process.emit('SIGTERM');

      expect(isShuttingDown()).toBe(true);
    });
  });

  describe('Case 7: shutdown timeout', () => {
    it('should force exit with code 1 after timeout', () => {
      const timeoutMs = 5000;
      setupGracefulShutdown(mockServer, mockLogger, timeoutMs);

      // Prevent server.close callback from being called
      mockServer.close = jest.fn(() => mockServer);

      process.emit('SIGTERM');

      // Should not have exited yet
      expect(process.exit).not.toHaveBeenCalledWith(1);

      // Advance time past timeout
      jest.advanceTimersByTime(timeoutMs);

      // Should force exit
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Shutdown timeout. Forcing exit')
      );
    });

    it('should use default timeout of 180000ms', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      mockServer.close = jest.fn(() => mockServer);

      process.emit('SIGTERM');

      // Advance time to just before default timeout
      jest.advanceTimersByTime(179999);
      expect(process.exit).not.toHaveBeenCalledWith(1);

      // Advance past timeout
      jest.advanceTimersByTime(2);
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('Case 8: server.close error', () => {
    it('should exit with code 1 when server.close fails', () => {
      const closeError = new Error('Failed to close server');

      mockServer.close = jest.fn((callback?: (err?: Error) => void) => {
        if (callback) callback(closeError);
        return mockServer;
      });

      setupGracefulShutdown(mockServer, mockLogger);

      process.emit('SIGTERM');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error during server close'),
        closeError
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('Case 9: idle vs active connections', () => {
    it('should destroy idle connections (no _httpMessage)', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      const idleSocket1 = createMockSocket(false);
      const idleSocket2 = createMockSocket(false);

      mockServer.emit('connection', idleSocket1);
      mockServer.emit('connection', idleSocket2);

      process.emit('SIGTERM');

      expect(idleSocket1.destroy).toHaveBeenCalled();
      expect(idleSocket2.destroy).toHaveBeenCalled();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Closed 2 idle connection(s), keeping 0 active connection(s)')
      );
    });

    it('should keep active connections (with _httpMessage)', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      const activeSocket1 = createMockSocket(true);
      const activeSocket2 = createMockSocket(true);

      mockServer.emit('connection', activeSocket1);
      mockServer.emit('connection', activeSocket2);

      process.emit('SIGTERM');

      expect(activeSocket1.destroy).not.toHaveBeenCalled();
      expect(activeSocket2.destroy).not.toHaveBeenCalled();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Closed 0 idle connection(s), keeping 2 active connection(s)')
      );
    });

    it('should handle mixed idle and active connections', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      const activeSocket = createMockSocket(true);
      const idleSocket = createMockSocket(false);

      mockServer.emit('connection', activeSocket);
      mockServer.emit('connection', idleSocket);

      process.emit('SIGTERM');

      expect(idleSocket.destroy).toHaveBeenCalled();
      expect(activeSocket.destroy).not.toHaveBeenCalled();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Closed 1 idle connection(s), keeping 1 active connection(s)')
      );
    });

    it('should remove connections from tracking when they close', () => {
      setupGracefulShutdown(mockServer, mockLogger);

      const socket = createMockSocket(false);
      mockServer.emit('connection', socket);

      // Socket closes before shutdown
      socket.emit('close');

      process.emit('SIGTERM');

      // Socket should not be in the set anymore, so 0 idle closed
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Closed 0 idle connection(s), keeping 0 active connection(s)')
      );
    });
  });

  describe('trackTask functionality', () => {
    it('should return the task result', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      const result = await trackTask('myTask', async () => {
        return 'task result';
      });

      expect(result).toBe('task result');
    });

    it('should log task start and completion', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      await trackTask('myTask', async () => 'done');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Task "myTask" started')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Task "myTask" completed')
      );
    });

    it('should remove task from tracking even if it throws', async () => {
      const { trackTask } = setupGracefulShutdown(mockServer, mockLogger);

      await expect(
        trackTask('failingTask', async () => {
          throw new Error('Task failed');
        })
      ).rejects.toThrow('Task failed');

      // Task should still be marked as completed (removed from tracking)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Task "failingTask" completed')
      );
    });
  });
});