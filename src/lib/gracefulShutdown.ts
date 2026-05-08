/**
 * Graceful Shutdown for Express/Node services
 *
 * This module ensures that when a container receives a shutdown signal (SIGTERM/SIGINT),
 * it stops accepting new requests and waits for in-flight requests to complete before exiting.
 *
 * KEY DISCOVERY: tsx/esbuild registers its own SIGTERM handler (in preflight.cjs/loader.mjs)
 * that calls process.exit() immediately, bypassing any graceful shutdown logic. This happens
 * whether you use `tsx` CLI directly or `node --require/--import` with tsx loaders.
 * The solution is to remove this handler at startup before registering our own.
 *
 * DOCKER SWARM NOTE: When using `docker stop` directly on a container, it uses its own
 * default timeout (10s), ignoring the stack's stop_grace_period. To respect the configured
 * stop_grace_period, use `docker service scale <service>=0` or `docker service update`.
 *
 * HOW IT WORKS:
 * 1. Remove tsx/esbuild's SIGTERM handler that would kill the process immediately
 * 2. Track all open TCP connections to the server
 * 3. Track active background tasks (e.g., cron jobs)
 * 4. On SIGTERM/SIGINT:
 *    - Wait for active background tasks to complete
 *    - Call server.close() which stops accepting new connections (TCP ECONNREFUSED)
 *    - Close idle keep-alive connections (no active request)
 *    - Wait for active requests to complete
 *    - Force exit after timeout if requests don't complete
 *
 * USAGE:
 *   const server = app.listen(port);
 *   export const { isShuttingDown, trackTask } = setupGracefulShutdown(server, LOGGER);
 *
 * The isShuttingDown() function can be used by cron jobs to check if they should
 * skip execution during shutdown.
 *
 * The trackTask() function wraps an async task and tracks it for graceful shutdown:
 *   await trackTask("myTask", async () => { ... });
 */

import type { Server } from 'http';
import type { Socket } from 'net';

export const setupGracefulShutdown = (server: Server, logger: any, timeoutMs = 180000) => {
  // CRITICAL: Remove tsx/esbuild's SIGTERM handler that prevents graceful shutdown.
  // The tsx loaders register a handler that immediately exits the process on SIGTERM,
  // which would kill in-flight requests. This must be done before any SIGTERM can arrive.
  const existingListeners = process.listeners('SIGTERM').length;
  for (const listener of process.listeners('SIGTERM')) {
    process.removeListener('SIGTERM', listener as NodeJS.SignalsListener);
  }
  logger.debug(`[GRACEFUL Shutdown Manager]: INIT: Removed ${existingListeners} existing SIGTERM listener(s)`);

  // Track all TCP connections to know when they're all closed.
  // This is necessary because server.close() only stops accepting NEW connections;
  // existing keep-alive connections stay open until they close or timeout.
  const connections = new Set<Socket>();

  server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
  });

  let isShuttingDown = false;

  // Track active background tasks (e.g., cron jobs)
  const activeTasks = new Map<string, Promise<any>>();

  /**
   * Track an async task for graceful shutdown.
   * The shutdown will wait for all tracked tasks to complete before closing the server.
   * @param taskName - A unique name for the task (used for logging)
   * @param task - The async function to execute
   * @returns The result of the task
   */
  const trackTask = async <T>(taskName: string, task: () => Promise<T>): Promise<T> => {
    if (isShuttingDown) {
      throw new Error(`Cannot start task "${taskName}" - server is shutting down`);
    }

    const taskPromise = task();
    activeTasks.set(taskName, taskPromise);
    logger.debug(`[GRACEFUL Shutdown Manager]: Task "${taskName}" started. Active tasks: ${activeTasks.size}`);

    try {
      return await taskPromise;
    } finally {
      activeTasks.delete(taskName);
      logger.debug(`[GRACEFUL Shutdown Manager]: Task "${taskName}" completed. Active tasks: ${activeTasks.size}`);
    }
  };

  const gracefulShutdown = async (signal: string) => {
    logger.info(`[GRACEFUL Shutdown Manager]: Shutdown triggered: ${signal} received. Starting graceful shutdown...`);

    // Prevent multiple shutdown attempts
    if (isShuttingDown) {
      logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Ignoring duplicate ${signal} signal`);
      return;
    }
    isShuttingDown = true;

    // While waiting for background tasks to finish, we may still accept connections

    logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Active tasks: ${activeTasks.size}`);

    // Wait for all active background tasks to complete
    if (activeTasks.size > 0) {
      logger.info(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Waiting for ${activeTasks.size} active task(s) to complete...`);

      const taskNames = Array.from(activeTasks.keys());
      logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Active tasks: ${taskNames.join(', ')}`);

      await Promise.allSettled(activeTasks.values());
      logger.info('[GRACEFUL Shutdown Manager]: Shutdown triggered: All background tasks completed.');
    }

    logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Active connections: ${connections.size}`);

    // Stop accepting new connections. The callback fires when all existing connections are closed.
    // New connection attempts will receive ECONNREFUSED at the TCP level (no HTTP response).
    logger.debug('[GRACEFUL Shutdown Manager]: Shutdown triggered: Calling server.close()');
    server.close((err) => {
      if (err) {
        logger.error('[GRACEFUL Shutdown Manager]: Shutdown triggered: Error during server close:', err);
        process.exit(1);
      }
      logger.info('[GRACEFUL Shutdown Manager]: Shutdown triggered: Server closed. All pending requests completed.');
      logger.debug('[GRACEFUL Shutdown Manager]: Shutdown triggered: Success: Exiting with code 0');

      process.exit(0);
    });

    // Close idle keep-alive connections that have no active request.
    // conn._httpMessage is set when a request is being processed on this connection.
    // This allows us to close idle connections while preserving active ones.
    let idleClosed = 0;
    let activeKept = 0;
    for (const conn of connections) {
      // @ts-ignore - _httpMessage is an internal Node.js property
      if (!conn._httpMessage) {
        conn.destroy();
        idleClosed++;
      } else {
        activeKept++;
      }
    }
    logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Closed ${idleClosed} idle connection(s), keeping ${activeKept} active connection(s)`);

    // Safety net: force exit if requests don't complete within timeout.
    // This prevents the container from hanging indefinitely.
    logger.debug(`[GRACEFUL Shutdown Manager]: Shutdown triggered: Setting force exit timeout to ${timeoutMs}ms`);
    setTimeout(() => {
      logger.warn('[GRACEFUL Shutdown Manager]: Shutdown triggered: Shutdown timeout. Forcing exit.');
      logger.debug('[GRACEFUL Shutdown Manager]: Shutdown triggered: Exiting with code 1 (timeout)');
      process.exit(1);
    }, timeoutMs);
  };

  // Register our graceful shutdown handler for both signals:
  // - SIGTERM: sent by Docker/Swarm when stopping a container
  // - SIGINT: sent when pressing Ctrl+C (useful for local development)
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  logger.debug('[GRACEFUL Shutdown Manager]: INIT: Registered SIGTERM and SIGINT handlers');

  // Return utilities for graceful shutdown management
  return {
    /** Check if the server is shutting down (cron jobs should skip execution) */
    isShuttingDown: () => isShuttingDown,
    /** Track an async task - shutdown will wait for it to complete */
    trackTask,
  };
};