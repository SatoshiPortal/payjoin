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
