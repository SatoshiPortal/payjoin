import { LockManager } from "./Locker";

const mockPgQuery = jest.fn();
const mockRelease = jest.fn();

const mockPgClient = {
  query: mockPgQuery,
  release: mockRelease,
  on: jest.fn(),
  removeListener: jest.fn(),
};

const mockConnect = jest.fn().mockResolvedValue(mockPgClient);

jest.mock("pg", () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      end: jest.fn(),
      on: jest.fn(),
    })),
  };
});

jest.mock("./Log2File", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("LockManager", () => {
  let lockManager: LockManager;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    lockManager = new LockManager();
    mockQuery = jest.fn();
    (lockManager as any).query = mockQuery;
  });

  describe("isBusy", () => {
    it("should return false when lock is available", async () => {
      mockQuery.mockResolvedValueOnce([{ count: 0 }]);

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("should return true when lock is busy", async () => {
      mockQuery.mockResolvedValueOnce([{ count: "1" }]);

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("should return true on error", async () => {
      mockQuery.mockRejectedValueOnce(new Error("Database error"));

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe("acquire", () => {
    it("should acquire lock, run callback, and release lock", async () => {
      const mockCallback = jest.fn().mockResolvedValueOnce("result");
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      const result = await lockManager.acquire("test-lock", mockCallback);

      expect(result).toBe("result");
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("it should acquire multiple locks at once, run callback and release locks", async () => {
      const mockCallback = jest.fn().mockResolvedValueOnce("result");
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      const result = await lockManager.acquire(["test-lock-1", "test-lock-2"], mockCallback);

      expect(result).toBe("result");
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("should release lock even if callback throws", async () => {
      const mockError = new Error("Callback error");
      const mockCallback = jest.fn().mockRejectedValueOnce(mockError);
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await expect(lockManager.acquire("test-lock", mockCallback)).rejects.toThrow(mockError);

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test("should work with null as lock key", async () => {
      const results: number[] = [];

      mockQuery.mockResolvedValue([{ locked: "true" }]);

      const promises = [
        lockManager.acquire(null, async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          results.push(1);
          return "first";
        }),
        lockManager.acquire(null, async () => {
          results.push(2);
          return "second";
        }),
        lockManager.acquire(null, async () => {
          results.push(3);
          return "third";
        }),
      ];

      // Wait for all operations to complete
      const completedResults = await Promise.all(promises);

      // Verify all callbacks ran and returned expected results
      expect(completedResults).toEqual(["first", "second", "third"]);
      expect(results.length).toBe(3);
      expect(results).toContain(1);
      expect(results).toContain(2);
      expect(results).toContain(3);
    }, 10000);

    test("should handle null keys alongside other keys", async () => {
      const results: string[] = [];

      // Use manual control of promises rather than timers
      let firstNullLockDone = false;
      let callCount = 0;

      mockQuery.mockImplementation(async () => {
        callCount++;

        if (callCount === 3) {
          // Third call (second null lock)
          return new Promise(resolve => {
            const checkInterval = setInterval(() => {
              if (firstNullLockDone) {
                clearInterval(checkInterval);
                resolve([{ locked: "true" }]);
              }
            }, 10);
          });
        } else {
          return Promise.resolve([{ locked: "true" }]);
        }
      });

      // Execute operations without fake timers
      const operation1 = lockManager.acquire(null, async () => {
        // First operation with null key
        results.push("null key 1");
        // brief sleep to simulate work
        await new Promise(resolve => setTimeout(resolve, 200));
        firstNullLockDone = true;
      });

      const operation2 = lockManager.acquire("other", async () => {
        // Operation with different key can run concurrently
        results.push("other key");
      });

      const operation3 = lockManager.acquire(null, async () => {
        // Second operation with null key must wait for first to finish
        results.push("null key 2");
      });

      await Promise.all([operation1, operation2, operation3]);

      // Check that null key operations were serialized
      expect(results.indexOf("null key 2")).toBeGreaterThan(results.indexOf("null key 1"));
    });

    test("should throw an error if the operation fails", async () => {
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await expect(
        lockManager.acquire(null, async () => {
          throw new Error("Operation failed");
        }),
      ).rejects.toThrow("Operation failed");

      // Verify lock is released after error
      const result = await lockManager.acquire(null, async () => "success");
      expect(result).toBe("success");
    });

    test("should handle concurrent null and undefined keys correctly", async () => {
      const results: string[] = [];

      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      // async-lock treats null and undefined as different keys
      const promise1 = lockManager.acquire(null, async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push("null");
        return "null result";
      });

      const promise2 = lockManager.acquire(undefined, async () => {
        results.push("undefined");
        return "undefined result";
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both operations should execute concurrently
      expect(result1).toBe("null result");
      expect(result2).toBe("undefined result");

      // undefined might execute before null completes due to the timeout
      expect(results).toContain("null");
      expect(results).toContain("undefined");
    });
  });

  describe("connection release", () => {
    it("should call pgClient.release() on successful acquire", async () => {
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await lockManager.acquire("test-lock", async () => "done");

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("should call pgClient.release() when callback throws", async () => {
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await expect(
        lockManager.acquire("test-lock", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("should call pgClient.release() when BEGIN fails (no locks acquired)", async () => {
      // Bypass the query mock — make the real pgClient.query throw on BEGIN
      // so we hit the error path before any lock is acquired
      (lockManager as any).query = undefined; // restore real path
      mockPgQuery.mockRejectedValueOnce(new Error("BEGIN failed")); // BEGIN
      mockPgQuery.mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        lockManager.acquire("test-lock", async () => "never"),
      ).rejects.toThrow("BEGIN failed");

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("should call pgClient.release() on isBusy error", async () => {
      mockQuery.mockRejectedValueOnce(new Error("query failed"));

      await lockManager.isBusy("test-lock");

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe("_connectionLocks cleanup", () => {
    it("should clear _connectionLocks after successful acquire", async () => {
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await lockManager.acquire("test-lock", async () => "done");

      expect((LockManager as any)._connectionLocks.size).toBe(0);
    });

    it("should clear _connectionLocks after callback throws", async () => {
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await expect(
        lockManager.acquire("test-lock", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect((LockManager as any)._connectionLocks.size).toBe(0);
    });
  });

  describe("timeout", () => {
    it("should throw and release connection when timeout fires before lock acquired", async () => {
      const slowLockManager = new LockManager();
      (slowLockManager as any).query = jest.fn().mockImplementation(() => {
        // Simulate a lock that takes longer than the timeout
        return new Promise(resolve => setTimeout(() => resolve([{ locked: "true" }]), 500));
      });

      await expect(
        slowLockManager.acquire("test-lock", async () => "never", 50),
      ).rejects.toThrow(/timed out/);

      expect(mockRelease).toHaveBeenCalled();
    });

    it("should not leak timers on successful acquire with timeout", async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      mockQuery.mockResolvedValueOnce([{ locked: "true" }]);

      await lockManager.acquire("test-lock", async () => "done", 5000);

      // If clearTimeout wasn't called, advancing timers would trigger the timeout warning.
      // We just verify no errors occur.
      jest.runAllTimers();
      jest.useRealTimers();
    });
  });

  describe("empty array edge case", () => {
    it("should execute callback directly without acquiring any connection", async () => {
      const result = await lockManager.acquire([], async () => "direct");

      expect(result).toBe("direct");
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("acquireNested - stale parent context", () => {
    it("should NOT reuse the parent pgClient for fire-and-forget tasks started during acquire", async () => {
      // This reproduces the bug where AsyncLocalStorage context outlives the parent
      // acquire callback. A fire-and-forget async task started inside acquire() should
      // get its own pgClient when it later calls acquire(), not reuse the parent's
      // (already released) client via acquireNested.

      let connectCount = 0;
      mockConnect.mockImplementation(() => {
        connectCount++;
        return Promise.resolve({
          query: jest.fn().mockResolvedValue({ rows: [{ locked: "true" }] }),
          release: jest.fn(),
          on: jest.fn(),
          removeListener: jest.fn(),
          _connectId: connectCount,
        });
      });

      const freshLockManager = new LockManager();

      // The deferred task's promise — started inside acquire but NOT awaited there
      let deferredAcquirePromise: Promise<any>;

      await freshLockManager.acquire("outer-lock", async () => {
        // Fire-and-forget: kick off an async task that yields before calling acquire.
        // This simulates triggerPostmix which awaits a delay before acquiring a lock.
        // The AsyncLocalStorage context propagates through the await, so without
        // the ctx.active fix this would call acquireNested on the parent's
        // (already released) pgClient.
        deferredAcquirePromise = (async () => {
          // Yield control so the outer callback returns and ctx.active becomes false
          await new Promise(resolve => setTimeout(resolve, 10));
          return freshLockManager.acquire("inner-lock", async () => {
            return "inner-result";
          });
        })();
      });

      // The outer acquire is done and its pgClient is released.
      // Now wait for the deferred inner acquire to complete.
      const innerResult = await deferredAcquirePromise!;
      expect(innerResult).toBe("inner-result");

      // The outer acquire uses 1 pgClient, the inner acquire should use a SEPARATE pgClient
      // (not reuse the parent's via acquireNested), so connect() must be called at least 2 times
      expect(connectCount).toBeGreaterThanOrEqual(2);
    });

    it("should reuse the parent pgClient for nested acquires within the same callback", async () => {
      // This is the valid nested case: a synchronous (awaited) acquire inside another acquire
      // should reuse the parent's pgClient via acquireNested.

      let connectCount = 0;
      mockConnect.mockImplementation(() => {
        connectCount++;
        return Promise.resolve({
          query: jest.fn().mockResolvedValue({ rows: [{ locked: "true" }] }),
          release: jest.fn(),
          on: jest.fn(),
          removeListener: jest.fn(),
          _connectId: connectCount,
        });
      });

      const freshLockManager = new LockManager();

      await freshLockManager.acquire("outer-lock", async () => {
        // This nested acquire happens within the parent callback (awaited),
        // so it should reuse the parent's pgClient via acquireNested
        const result = await freshLockManager.acquire("inner-lock", async () => {
          return "nested-result";
        });
        expect(result).toBe("nested-result");
      });

      // Only 1 pgClient should have been created (the parent's),
      // because the nested acquire reused it
      expect(connectCount).toBe(1);
    });

    it("should wait for fire-and-forget nested acquires to finish before committing", async () => {
      // Reproduces: a fire-and-forget task enters acquireNested while the parent
      // callback is still running (ctx.active is true), then the parent callback
      // returns. The parent must wait for the nested callback to finish before
      // committing the transaction and releasing the pgClient.

      const commitOrder: string[] = [];

      mockConnect.mockImplementation(() => {
        return Promise.resolve({
          query: jest.fn().mockImplementation(async (sql: string) => {
            if (sql === "COMMIT") {
              commitOrder.push("commit");
            }
            return { rows: [{ locked: "true" }] };
          }),
          release: jest.fn(),
          on: jest.fn(),
          removeListener: jest.fn(),
        });
      });

      const freshLockManager = new LockManager();

      await freshLockManager.acquire("outer-lock", async () => {
        // Fire-and-forget nested acquire — starts while ctx.active is true
        // so it enters acquireNested on the parent's pgClient
        freshLockManager.acquire("inner-lock", async () => {
          // Simulate work that takes longer than the parent callback
          await new Promise(resolve => setTimeout(resolve, 200));
          commitOrder.push("nested-done");
        });

        // Small yield so the nested acquire has time to start and enter acquireNested
        await new Promise(resolve => setTimeout(resolve, 10));
        commitOrder.push("parent-callback-done");
      });

      // The nested callback must finish BEFORE the commit
      expect(commitOrder).toEqual(["parent-callback-done", "nested-done", "commit"]);
    });
  });

  describe("acquireNested - error handling", () => {
    it("should decrement nestedCount and clean up _connectionLocks when nested callback throws", async () => {
      mockConnect.mockImplementation(() => {
        return Promise.resolve({
          query: jest.fn().mockResolvedValue({ rows: [{ locked: "true" }] }),
          release: jest.fn(),
          on: jest.fn(),
          removeListener: jest.fn(),
        });
      });

      const freshLockManager = new LockManager();

      await expect(
        freshLockManager.acquire("outer-lock", async () => {
          await freshLockManager.acquire("inner-lock", async () => {
            throw new Error("nested boom");
          });
        }),
      ).rejects.toThrow("nested boom");

      // Both outer and inner lock IDs should be cleaned up
      expect((LockManager as any)._connectionLocks.size).toBe(0);
    });
  });

  describe("hashStringToInt", () => {
    it("should generate the same hash for the same string", () => {
      const hashFn = (lockManager as any).hashStringToInt.bind(lockManager);

      const hash1 = hashFn("test-lock");
      const hash2 = hashFn("test-lock");

      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("number");
      expect(hash1).toBeGreaterThan(0);
    });

    it("should generate different hashes for different strings", () => {
      const hashFn = (lockManager as any).hashStringToInt.bind(lockManager);

      const hash1 = hashFn("lock-1");
      const hash2 = hashFn("lock-2");

      expect(hash1).not.toBe(hash2);
    });
  });
});
