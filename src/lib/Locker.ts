import { PrismaClient } from "@prisma/client";
import logger from "./Log2File";
import { isStubMode } from "./StubMode";

/**
 * LockManager provides distributed locking using PostgreSQL advisory locks via Prisma
 */
export class LockManager {
  private _prisma: PrismaClient;
  private _defaultTimeout: number;
  // Special reserved lock IDs for null and undefined keys
  private readonly NULL_LOCK_ID = 1;
  private readonly UNDEFINED_LOCK_ID = 2;

  // In-memory tracking of locks acquired by this connection
  private static _connectionLocks: Map<number, boolean> = new Map();

  constructor(defaultTimeout: number = 60000) {
    this._prisma = new PrismaClient();
    this._defaultTimeout = defaultTimeout;
  }

  /**
   * Checks if a named lock is currently being held by any process
   *
   * @param lockName - Unique name for the lock (or null)
   * @returns Promise<boolean> - true if the lock is busy, false if it's available
   */
  async isBusy(lockName: string | null | undefined): Promise<boolean> {
    if (isStubMode()) {
      logger.debug(
        `[LockManager] isBusy :: Stub mode is enabled, reporting lock "${String(
          lockName,
        )}" as not busy`,
      );
      return false;
    }

    const lockId = this.getLockId(lockName);

    // Check in-memory first for same-connection locks
    if (LockManager._connectionLocks.has(lockId)) {
      return true;
    }

    try {
      // Then check PostgreSQL for cross-connection locks
      const result = await this._prisma.$queryRaw<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM pg_locks
        WHERE locktype = 'advisory' 
        AND (classid = 0 AND objid = ${lockId})
        AND granted = true;
      `;

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

    if (isStubMode()) {
      logger.debug(
        `[LockManager] acquire :: Stub mode is enabled, skipping lock acquisition for "${locks.join(
          ", ",
        )}"`,
      );
      return await callback();
    }

    // Sort locks by name to ensure consistent acquisition order and prevent deadlocks
    const sortedLocks = [...locks].sort();
    const lockIds = sortedLocks.map(name => this.getLockId(name));

    logger.debug(
      `[LockManager] Waiting to acquire ${lockIds.length} locks: ${sortedLocks.join(", ")}`,
    );

    // Set up timeout tracking
    const startTime = Date.now();
    let timeoutId: NodeJS.Timeout | undefined;
    let timeoutHandled = false;
    const actualTimeout = timeout || this._defaultTimeout;

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

    try {
      // Acquire locks one by one in sorted order
      for (let i = 0; i < lockIds.length; i++) {
        const lockId = lockIds[i];
        const lockName = sortedLocks[i];

        // Check if we've timed out before acquiring this lock
        if (timeoutHandled) {
          throw new Error(`Locks acquisition timed out after ${actualTimeout}ms`);
        }

        logger.debug(
          `[LockManager] Attempting to acquire lock "${String(lockName)}" (${i + 1}/${
            lockIds.length
          })`,
        );

        // First check if we already have this lock in our own connection
        if (LockManager._connectionLocks.has(lockId)) {
          // Need to wait for our own connection to release this lock
          await this.waitForLocalLockRelease(lockId, actualTimeout - (Date.now() - startTime));
        }

        // Acquire this specific lock in PostgreSQL
        await this._prisma.$queryRaw`
          SELECT (pg_advisory_lock(${lockId}) IS NOT NULL)::text as locked
        `;

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

      // Execute callback now that we have all the locks
      return await callback();
    } finally {
      // Release all acquired locks in reverse order
      if (!timeoutHandled && acquiredLockIds.length > 0) {
        for (let i = acquiredLockIds.length - 1; i >= 0; i--) {
          const lockId = acquiredLockIds[i];
          const lockName = sortedLocks[i];

          try {
            // Remove from our in-memory tracking
            LockManager._connectionLocks.delete(lockId);

            // Release in PostgreSQL
            await this._prisma.$queryRaw`
              SELECT (pg_advisory_unlock(${lockId}))::text as released
            `;
            logger.debug(`[LockManager] Released lock "${String(lockName)}"`);
          } catch (unlockError) {
            logger.error(
              `[LockManager] Failed to release lock "${String(lockName)}":`,
              unlockError,
            );
          }
        }
        logger.debug(`[LockManager] Released all ${acquiredLockIds.length} locks`);
      }
    }
  }

  /**
   * Wait for a local lock to be released with a polling mechanism
   */
  private async waitForLocalLockRelease(lockId: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 50; // Poll every 50ms

    logger.debug(`[LockManager] Waiting for local lock ${lockId} to be released...`);

    while (LockManager._connectionLocks.has(lockId)) {
      // Check if we've timed out
      if (Date.now() - startTime > timeoutMs) {
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
