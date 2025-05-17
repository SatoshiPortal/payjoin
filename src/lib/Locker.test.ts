import { LockManager } from "./Locker";
import * as StubMode from "./StubMode";

const mockQueryRaw = jest.fn();

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $queryRaw: mockQueryRaw,
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

jest.mock("./StubMode", () => ({
  isStubMode: jest.fn(),
}));

describe("LockManager", () => {
  let lockManager: LockManager;

  beforeEach(() => {
    jest.clearAllMocks();
    (StubMode.isStubMode as jest.Mock).mockReturnValue(false);
    lockManager = new LockManager();
  });

  describe("isBusy", () => {
    it("should return false when lock is available", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ count: 0 }]);

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(false);
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("should return true when lock is busy", async () => {
      mockQueryRaw.mockResolvedValueOnce([{ count: "1" }]);

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(true);
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("should return false in stub mode", async () => {
      (StubMode.isStubMode as jest.Mock).mockReturnValue(true);

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(false);
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("should return true on error", async () => {
      mockQueryRaw.mockRejectedValueOnce(new Error("Database error"));

      const result = await lockManager.isBusy("test-lock");

      expect(result).toBe(true);
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe("acquire", () => {
    it("should acquire lock, run callback, and release lock", async () => {
      const mockCallback = jest.fn().mockResolvedValueOnce("result");
      mockQueryRaw.mockResolvedValueOnce([{ locked: "true" }]);
      mockQueryRaw.mockResolvedValueOnce([{ released: "true" }]);

      const result = await lockManager.acquire("test-lock", mockCallback);

      expect(result).toBe("result");
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    });

    it("it should acquire multiple locks at once, run callback and release locks", async () => {
      const mockCallback = jest.fn().mockResolvedValueOnce("result");
      mockQueryRaw.mockResolvedValueOnce([{ locked: "true" }]);
      mockQueryRaw.mockResolvedValueOnce([{ released: "true" }]);

      const result = await lockManager.acquire(["test-lock-1", "test-lock-2"], mockCallback);

      expect(result).toBe("result");
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQueryRaw).toHaveBeenCalledTimes(4);
    });

    it("should release lock even if callback throws", async () => {
      const mockError = new Error("Callback error");
      const mockCallback = jest.fn().mockRejectedValueOnce(mockError);
      mockQueryRaw.mockResolvedValueOnce([{ locked: "true" }]);
      mockQueryRaw.mockResolvedValueOnce([{ released: "true" }]);

      await expect(lockManager.acquire("test-lock", mockCallback)).rejects.toThrow(mockError);

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    });

    it("should skip lock acquisition in stub mode", async () => {
      (StubMode.isStubMode as jest.Mock).mockReturnValue(true);
      const mockCallback = jest.fn().mockResolvedValueOnce("result");

      const result = await lockManager.acquire("test-lock", mockCallback);

      expect(result).toBe("result");
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    test("should work with null as lock key", async () => {
      const results: number[] = [];
      let resolveFirstLock: () => void;
      let resolveSecondLock: () => void;

      // First lock acquisition - for the first null key
      mockQueryRaw.mockImplementationOnce(async () => {
        return [{ locked: "true" }];
      });

      // Second lock acquisition - for the second null key
      // This shouldn't resolve until the first lock is released
      mockQueryRaw.mockImplementationOnce(async () => {
        return new Promise(resolve => {
          resolveFirstLock = () => resolve([{ locked: "true" }]);
        });
      });

      // Third lock acquisition - for the third null key
      // This shouldn't resolve until the second lock is released
      mockQueryRaw.mockImplementationOnce(async () => {
        return new Promise(resolve => {
          resolveSecondLock = () => resolve([{ locked: "true" }]);
        });
      });

      // First lock release - should trigger the second lock acquisition
      mockQueryRaw.mockImplementationOnce(async () => {
        setTimeout(() => resolveFirstLock(), 0);
        return [{ released: "true" }];
      });

      // Second lock release - should trigger the third lock acquisition
      mockQueryRaw.mockImplementationOnce(async () => {
        setTimeout(() => resolveSecondLock(), 0);
        return [{ released: "true" }];
      });

      // Third lock release
      mockQueryRaw.mockImplementationOnce(async () => {
        return [{ released: "true" }];
      });

      // Create multiple concurrent operations with the same null key
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

      // Verify operations were executed sequentially, not concurrently
      expect(results).toEqual([1, 2, 3]);
      expect(completedResults).toEqual(["first", "second", "third"]);
    });

    test("should handle null keys alongside other keys", async () => {
      // Set a short timeout for the test
      const lockManager = new LockManager(500); // Use a short timeout of 500ms for tests

      const results: string[] = [];

      // Use manual control of promises rather than timers
      let firstNullLockDone = false;

      // For the first null lock
      mockQueryRaw.mockImplementationOnce(() => {
        return Promise.resolve([{ locked: "true" }]);
      });

      // For the other key lock
      mockQueryRaw.mockImplementationOnce(() => {
        return Promise.resolve([{ locked: "true" }]);
      });

      // For the second null lock - blocks until first null is done
      mockQueryRaw.mockImplementationOnce(() => {
        return new Promise(resolve => {
          const checkInterval = setInterval(() => {
            if (firstNullLockDone) {
              clearInterval(checkInterval);
              resolve([{ locked: "true" }]);
            }
          }, 10);
        });
      });

      // First null lock release
      mockQueryRaw.mockImplementationOnce(() => {
        firstNullLockDone = true;
        return Promise.resolve([{ released: "true" }]);
      });

      // Other key release
      mockQueryRaw.mockImplementationOnce(() => {
        return Promise.resolve([{ released: "true" }]);
      });

      // Second null lock release
      mockQueryRaw.mockImplementationOnce(() => {
        return Promise.resolve([{ released: "true" }]);
      });

      // Execute operations without fake timers
      const operation1 = lockManager.acquire(null, async () => {
        // First operation with null key
        results.push("null key 1");
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
