import { PrismaClient } from "@prisma/client";
import logger from "./Log2File";
import { isStubMode } from "./StubMode";

/**
 * LockManager provides distributed locking using PostgreSQL advisory locks via Prisma
 */
export class LockManager {
  private _prisma: PrismaClient;
  private _defaultTimeout: number;

  constructor(defaultTimeout: number = 60000) {
    this._prisma = new PrismaClient();
    this._defaultTimeout = defaultTimeout;
  }

  /**
   * Checks if a named lock is currently being held by any process
   *
   * @param lockName - Unique name for the lock
   * @returns Promise<boolean> - true if the lock is busy, false if it's available
   */
  async isBusy(lockName: string): Promise<boolean> {
    if (isStubMode()) {
      logger.debug(
        `[LockManager] isBusy :: Stub mode is enabled, reporting lock "${lockName}" as not busy`,
      );
      return false;
    }
  
    const lockId = this.hashStringToInt(lockName);
  
    try {
      // Directly query pg_locks to see if anyone holds this lock
      const result = await this._prisma.$queryRaw<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM pg_locks
        WHERE locktype = 'advisory' 
        AND (classid = 0 AND objid = ${lockId})
        AND granted = true;
      `;
  
      const lockCount = parseInt(result[0].count, 10);
      const isBusy = lockCount > 0;
      
      logger.debug(`[LockManager] Lock "${lockName}" is ${isBusy ? 'busy' : 'available'} (count: ${lockCount})`);
      
      return isBusy;
    } catch (error) {
      logger.error(`[LockManager] Error checking lock status for "${lockName}":`, error);
      return true; // Assume busy on error
    }
  }

  /**
   * Acquires one or more named locks and executes the callback while holding all locks
   * This is a blocking operation that will wait until all locks are available
   * Locks are acquired in a deterministic order to prevent deadlocks
   *
   * @param lockNames - Single lock name or array of lock names
   * @param callback - Function to execute while holding the lock(s)
   * @param timeout - Optional timeout in milliseconds (defaults to 60000)
   * @returns Result of the callback function
   */
  async acquire<T>(
    lockNames: string | string[],
    callback: () => Promise<T>,
    timeout?: number,
  ): Promise<T> {
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
    const lockIds = sortedLocks.map(name => this.hashStringToInt(name));

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

        // Acquire this specific lock
        await this._prisma.$queryRaw`
          SELECT (pg_advisory_lock(${lockId}) IS NOT NULL)::text as locked
        `;

        // Remember that we acquired this lock
        acquiredLockIds.push(lockId);
        logger.debug(`[LockManager] Acquired lock "${lockName}" (${i + 1}/${lockIds.length})`);
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
            await this._prisma.$queryRaw`
              SELECT (pg_advisory_unlock(${lockId}))::text as released
            `;
            logger.debug(`[LockManager] Released lock "${lockName}"`);
          } catch (unlockError) {
            logger.error(`[LockManager] Failed to release lock "${lockName}":`, unlockError);
          }
        }
        logger.debug(`[LockManager] Released all ${acquiredLockIds.length} locks`);
      }
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

    return Math.abs(hash);
  }
}

export default LockManager;
