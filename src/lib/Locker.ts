import { AsyncLocalStorage } from "async_hooks";
import { Pool, PoolClient } from "pg";
import logger from "./Log2File";
import { isShuttingDown } from "./gracefulShutdownRefs";

/**
 * LockManager provides distributed locking using PostgreSQL advisory locks via Prisma
 */
export class LockManager {
  private _pool: Pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    max: 50, // Increased max connections for better concurrency
  });
  private _defaultTimeout: number;
  // Special reserved lock IDs for null and undefined keys
  private readonly NULL_LOCK_ID = 1;
  private readonly UNDEFINED_LOCK_ID = 2;

  // In-memory tracking of locks acquired by this connection
  private static _connectionLocks: Map<number, boolean> = new Map();

  // Allows nested acquire() calls to reuse the parent's PG client/transaction.
  // nestedCount tracks how many nested acquires are running on this context;
  // the parent waits for all nested callbacks to finish before committing.
  private static _asyncStorage = new AsyncLocalStorage<{
    client: PoolClient;
    active: boolean;
    nestedCount: number;
  }>();

  constructor(defaultTimeout: number = 0) {
    this._defaultTimeout = defaultTimeout;

    this._pool.on("error", err => {
      if (isShuttingDown()) {
        logger.debug("[LockManager] PG Pool error during shutdown (expected):", err.message);
        return;
      }
      logger.error("[LockManager] PG Pool error:", err);
    });
  }

  private async getPgClient(): Promise<PoolClient> {
    const maxRetries = 3,
      baseDelayMs = 500;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const client = await this._pool.connect();
        const errorHandler = (err: any) => {
          if (isShuttingDown()) {
            logger.debug("[LockManager] PG PoolClient error during shutdown (expected):", err.message);
            return;
          }
          logger.error("[LockManager] PG PoolClient error:", err);
        };
        client.on("error", errorHandler);

        // Store the handler to remove later
        (client as any)._lockManagerErrorHandler = errorHandler;

        return client;
      } catch (err: any) {
        attempt++;
        logger.warn(
          `[LockManager] Pool connect attempt ${attempt}/${maxRetries} failed: ${err.message}`,
        );

        if (attempt >= maxRetries) {
          logger.error(`[LockManager] Pool connect failed after ${maxRetries} attempts:`, err);
          throw err; // Re-throw after exhausting retries
        }

        // Exponential backoff: wait before retrying
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        logger.debug(`[LockManager] Retrying pool connect in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw new Error("Unexpected error in getPgClient"); // Fallback
  }

  private async query<T = any>(
    pgClient: PoolClient,
    sql: string,
    params: any[] = [],
  ): Promise<T[]> {
    const result = await pgClient.query(sql, params);
    return result.rows as T[];
  }

  async close() {
    await this._pool.end();
  }

  /**
   * Checks if a named lock is currently being held by any process
   *
   * @param lockName - Unique name for the lock (or null)
   * @returns Promise<boolean> - true if the lock is busy, false if it's available
   */
  async isBusy(lockName: string | null | undefined): Promise<boolean> {
    const lockId = this.getLockId(lockName);

    // Check in-memory first for same-connection locks
    if (LockManager._connectionLocks.has(lockId)) {
      return true;
    }

    const pgClient = await this.getPgClient();
    try {
      // Then check PostgreSQL for cross-connection locks
      const result = await this.query(
        pgClient,
        `
        SELECT COUNT(*) as count
        FROM pg_locks
        WHERE locktype = 'advisory' 
        AND (classid = 0 AND objid = $1)
        AND granted = true;
      `,
        [lockId],
      );

      const lockCount = parseInt(result[0].count, 10);
      const isBusy = lockCount > 0;

      logger.debug(
        `[LockManager] Lock "${String(lockName)}" is ${
          isBusy ? "busy" : "available"
        } (count: ${lockCount})`,
      );

      return isBusy;
    } catch (error) {
      logger.error(`[LockManager] Error checking lock status for "${String(lockName)}":`, error);
      return true; // Assume busy on error
    } finally {
      pgClient.release();
    }
  }

  /**
   * Acquires one or more named locks and executes the callback while holding all locks
   * This is a blocking operation that will wait until all locks are available
   * Locks are acquired in a deterministic order to prevent deadlocks
   *
   * @param lockNames - Single lock name (or null) or array of lock names
   * @param callback - Function to execute while holding the lock(s)
   * @param timeout - Optional timeout in milliseconds (defaults to 60000)
   * @returns Result of the callback function
   */
  async acquire<T>(
    lockNames: string | string[] | null | undefined,
    callback: () => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    // Handle special cases: null or undefined
    // if (lockNames === null || lockNames === undefined) {
    //   logger.debug(
    //     `[LockManager] Acquiring special lock: ${lockNames === null ? "null" : "undefined"}`,
    //   );
    //   return this.acquireSingleLock(lockNames, callback, timeout);
    // }

    // Convert single lock name to array for consistent handling
    const locks = Array.isArray(lockNames) ? lockNames : [lockNames];

    if (locks.length === 0) {
      logger.debug(`[LockManager] No locks specified, executing callback directly`);
      return await callback();
    }

    // Sort locks by name to ensure consistent acquisition order and prevent deadlocks
    const sortedLocks = [...locks].sort();
    const lockIds = sortedLocks.map(name => this.getLockId(name));

    // If we're inside a parent acquire(), reuse its PG client instead of taking a new one
    const parentCtx = LockManager._asyncStorage.getStore();
    if (parentCtx?.active) {
      return this.acquireNested(parentCtx, sortedLocks, lockIds, callback);
    }

    logger.debug(
      `[LockManager] Waiting to acquire ${lockIds.length} locks: ${sortedLocks.join(", ")}`,
    );

    // Set up timeout tracking
    const startTime = Date.now();
    let timeoutId: NodeJS.Timeout | undefined;
    let timeoutHandled = false;
    const actualTimeout = timeout ?? this._defaultTimeout;

    if (actualTimeout > 0) {
      timeoutId = setTimeout(() => {
        timeoutHandled = true;
        logger.warn(
          `[LockManager] Timed out waiting for locks "${sortedLocks.join(
            ", ",
          )}" after ${actualTimeout}ms`,
        );
      }, actualTimeout);
    }

    // Track which locks we've acquired so we can release them in reverse order
    const acquiredLockIds: number[] = [];
    const pgClient = await this.getPgClient();

    try {
      // Start transaction
      await pgClient.query("BEGIN");

      // Acquire locks one by one in sorted order
      for (let i = 0; i < lockIds.length; i++) {
        const lockId = lockIds[i];
        const lockName = sortedLocks[i];

        // Check if we've timed out before acquiring this lock
        if (timeoutHandled) {
          throw new Error(`Locks acquisition timed out after ${actualTimeout}ms`);
        }

        logger.debug(
          `[LockManager] Attempting to acquire lock "${String(lockName)}" (lockId: ${lockId}) - (${
            i + 1
          }/${lockIds.length})`,
        );

        // First check if we already have this lock in our own connection
        if (LockManager._connectionLocks.has(lockId)) {
          // Need to wait for our own connection to release this lock
          // Pass Infinity when actualTimeout is 0 (wait indefinitely)
          const remainingTimeout =
            actualTimeout <= 0 ? Infinity : actualTimeout - (Date.now() - startTime);
          await this.waitForLocalLockRelease(lockId, remainingTimeout);
        }

        // Acquire this specific lock in PostgreSQL
        const [{ locked }] = (await this.query(
          pgClient,
          `
          SELECT (pg_advisory_xact_lock($1) IS NOT NULL)::text as locked
        `,
          [lockId],
        )) as [{ locked: string }];

        if (locked !== "true") {
          throw new Error(
            `[LockManager] Failed to acquire lock "${String(
              lockName,
            )}" - advisory lock returned: ${locked}`,
          );
        }

        // Track the lock both in the release list for this call and in the connection locks
        acquiredLockIds.push(lockId);
        LockManager._connectionLocks.set(lockId, true);

        logger.debug(
          `[LockManager] Acquired lock "${String(lockName)}" (${i + 1}/${lockIds.length})`,
        );
      }

      // Check if timeout occurred during lock acquisition
      if (timeoutHandled) {
        throw new Error(`Locks acquisition timed out after ${actualTimeout}ms`);
      }

      const acquireTime = Date.now() - startTime;
      if (acquireTime > 1000) {
        // Only log if it took more than 1 second to acquire
        logger.info(
          `[LockManager] Acquired all ${lockIds.length} locks after waiting ${acquireTime}ms`,
        );
      } else {
        logger.debug(`[LockManager] Successfully acquired all ${lockIds.length} locks`);
      }

      // Clear timeout since we acquired all locks successfully
      if (timeoutId) clearTimeout(timeoutId);

      // Execute callback within async context so nested acquires reuse this client.
      // The ctx.active flag is set to false once the callback completes, so that any
      // fire-and-forget async work started AFTER the callback won't enter acquireNested.
      // We then wait for any in-flight nested acquires (nestedCount) to finish before
      // committing, so their advisory locks and queries aren't severed mid-execution.
      const ctx = { client: pgClient, active: true, nestedCount: 0 };
      const result = await LockManager._asyncStorage.run(ctx, async () => {
        try {
          return await callback();
        } finally {
          ctx.active = false;
        }
      });

      // Wait for any fire-and-forget nested acquires that entered acquireNested
      // while the callback was still running (ctx.active was true) to finish
      if (ctx.nestedCount > 0) {
        logger.debug(
          `[LockManager] Waiting for ${ctx.nestedCount} in-flight nested acquire(s) to finish before committing`,
        );
        const pollIntervalMs = 50;
        while (ctx.nestedCount > 0) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        logger.debug(`[LockManager] All nested acquires finished`);
      }

      // Commit transaction (auto-releases all locks)
      await pgClient.query("COMMIT");
      logger.debug(`[LockManager] Transaction committed, locks released`);

      return result;
    } catch (error) {
      // Rollback on error (auto-releases locks)
      await pgClient.query("ROLLBACK");
      logger.error(`[LockManager] Transaction rolled back:`, error);
      throw error;
    } finally {
      // Release all acquired locks in reverse order
      if (acquiredLockIds.length > 0) {
        acquiredLockIds.forEach(id => LockManager._connectionLocks.delete(id));
        logger.debug(`[LockManager] Released all ${acquiredLockIds.length} locks`);
      }

      if ((pgClient as any)._lockManagerErrorHandler) {
        pgClient.removeListener("error", (pgClient as any)._lockManagerErrorHandler);
      }
      pgClient.release();
    }
  }

  /**
   * Acquires locks on an existing PG client/transaction from a parent acquire() call.
   * No new connection is taken from the pool — advisory locks are added to the parent's transaction.
   */
  private async acquireNested<T>(
    ctx: { client: PoolClient; active: boolean; nestedCount: number },
    sortedLocks: (string | null | undefined)[],
    lockIds: number[],
    callback: () => Promise<T>,
  ): Promise<T> {
    const pgClient = ctx.client;
    const acquiredLockIds: number[] = [];

    // Increment nested count so the parent knows to wait before committing
    ctx.nestedCount++;

    logger.debug(
      `[LockManager] Nested acquire of ${lockIds.length} lock(s): ${sortedLocks.join(", ")} (nestedCount: ${ctx.nestedCount})`,
    );

    try {
      for (let i = 0; i < lockIds.length; i++) {
        const lockId = lockIds[i];
        const lockName = sortedLocks[i];

        logger.debug(
          `[LockManager] Nested: acquiring lock "${String(lockName)}" (lockId: ${lockId}) - (${
            i + 1
          }/${lockIds.length})`,
        );

        const [{ locked }] = (await this.query(
          pgClient,
          `SELECT (pg_advisory_xact_lock($1) IS NOT NULL)::text as locked`,
          [lockId],
        )) as [{ locked: string }];

        if (locked !== "true") {
          throw new Error(
            `[LockManager] Nested: failed to acquire lock "${String(lockName)}" - advisory lock returned: ${locked}`,
          );
        }

        acquiredLockIds.push(lockId);
        LockManager._connectionLocks.set(lockId, true);

        logger.debug(
          `[LockManager] Nested: acquired lock "${String(lockName)}" (${i + 1}/${lockIds.length})`,
        );
      }

      return await callback();
    } finally {
      ctx.nestedCount--;
      acquiredLockIds.forEach(id => LockManager._connectionLocks.delete(id));
      logger.debug(`[LockManager] Nested: released ${acquiredLockIds.length} lock(s) (nestedCount: ${ctx.nestedCount})`);
    }
  }

  /**
   * Wait for a local lock to be released with a polling mechanism
   */
  private async waitForLocalLockRelease(lockId: number, timeoutMs: number): Promise<void> {
    const waitIndefinitely = timeoutMs <= 0;
    const startTime = Date.now();
    const pollIntervalMs = 50; // Poll every 50ms

    logger.debug(`[LockManager] Waiting for local lock ${lockId} to be released...`);

    while (LockManager._connectionLocks.has(lockId)) {
      // Check if we've timed out
      if (!waitIndefinitely && Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timeout waiting for local lock ${lockId} to be released after ${timeoutMs}ms`,
        );
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    logger.debug(`[LockManager] Local lock ${lockId} is now available`);
  }

  /**
   * Gets the lock ID for the given lock name, handling null and undefined
   */
  private getLockId(lockName: string | null | undefined): number {
    if (lockName === null) {
      return this.NULL_LOCK_ID;
    } else if (lockName === undefined) {
      return this.UNDEFINED_LOCK_ID;
    } else {
      return this.hashStringToInt(lockName);
    }
  }

  /**
   * Converts a string to a 32-bit integer for use as a lock key
   */
  private hashStringToInt(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }

    // Ensure we don't collide with the special NULL/UNDEFINED lock IDs
    const absHash = Math.abs(hash);

    // Avoid collisions with reserved IDs 1 and 2
    if (absHash === this.NULL_LOCK_ID || absHash === this.UNDEFINED_LOCK_ID) {
      return absHash + 1000; // Add a large offset to avoid collisions
    }

    return absHash || 3; // Ensure non-zero (0 hash becomes 3)
  }
}

export default LockManager;
