import { claimSeenInputsForSession, SeenInputConflictError, outpointKey } from './seenInputs';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('./db', () => ({
  db: { $transaction: jest.fn() },
}));

jest.mock('./Log2File', () => ({
  __esModule: true,
  default: {
    silly: jest.fn(), trace: jest.fn(), debug: jest.fn(),
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('./db');

// ---------------------------------------------------------------------------
// Stateful fake of the seen_inputs table + Prisma interactive transaction.
//
// Encodes the Postgres semantics claimSeenInputsForSession relies on:
//  - a unique index on (txid, vout): createMany with skipDuplicates behaves
//    like INSERT ... ON CONFLICT DO NOTHING, and a concurrent insert of the
//    same key BLOCKS until the transaction holding the speculative index
//    entry commits or rolls back (per-key promise-queue below);
//  - transactionality: staged writes only become visible to other
//    transactions when the callback resolves; a throw discards them.
// ---------------------------------------------------------------------------

interface Row { txid: string; vout: number; bip21: string | null }

class FakeSeenInputsDb {
  committed = new Map<string, Row>();
  createManyData: Row[][] = [];
  private lockTails = new Map<string, Promise<void>>();

  seed(txid: string, vout: number, bip21: string | null) {
    this.committed.set(`${txid}:${vout}`, { txid, vout, bip21 });
  }

  owner(txid: string, vout: number): string | null | undefined {
    return this.committed.get(`${txid}:${vout}`)?.bip21;
  }

  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const staged = new Map<string, Row>();
    const releases: Array<() => void> = [];

    const acquire = async (key: string) => {
      const prev = this.lockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      this.lockTails.set(key, prev.then(() => held));
      await prev; // block while another open transaction holds this key
      releases.push(release);
    };

    const tx = {
      seenInputs: {
        createMany: async ({ data }: { data: Row[] }) => {
          this.createManyData.push(data.map((d) => ({ ...d, bip21: d.bip21 ?? null })));
          for (const d of data) {
            const key = `${d.txid}:${d.vout}`;
            await acquire(key);
            if (!this.committed.has(key)) {
              staged.set(key, { txid: d.txid, vout: d.vout, bip21: d.bip21 ?? null });
            }
          }
          return { count: staged.size };
        },
        findMany: async ({ where }: { where: { OR: Array<{ txid: string; vout: number }> } }) => {
          return where.OR
            .map(({ txid, vout }) => this.committed.get(`${txid}:${vout}`) ?? staged.get(`${txid}:${vout}`))
            .filter((r): r is Row => r !== undefined);
        },
      },
    };

    try {
      const result = await fn(tx);
      for (const [k, v] of staged) this.committed.set(k, v); // commit
      return result;
    } finally {
      for (const release of releases) release();
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BIP21_A = 'bitcoin:bc1qsessiona?amount=0.001&pj=https://example.com/a';
const BIP21_B = 'bitcoin:bc1qsessionb?amount=0.002&pj=https://example.com/b';

const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);

let store: FakeSeenInputsDb;

beforeEach(() => {
  store = new FakeSeenInputsDb();
  (db.$transaction as jest.Mock).mockReset();
  (db.$transaction as jest.Mock).mockImplementation((fn: (tx: unknown) => Promise<unknown>) => store.transaction(fn));
});

describe('claimSeenInputsForSession — durable atomic seen-input claims', () => {
  it('claims unseen outpoints for the session', async () => {
    await expect(claimSeenInputsForSession(BIP21_A, [
      { txid: T1, vout: 0 },
      { txid: T2, vout: 1 },
    ])).resolves.toBeUndefined();

    expect(store.owner(T1, 0)).toBe(BIP21_A);
    expect(store.owner(T2, 1)).toBe(BIP21_A);
  });

  it('rejects a delayed replay of an outpoint claimed by another session (no expiry)', async () => {
    // Claims are permanent — this holds regardless of how long ago the
    // original claim was made, and across application restarts.
    store.seed(T1, 0, BIP21_A);

    await expect(claimSeenInputsForSession(BIP21_B, [{ txid: T1, vout: 0 }]))
      .rejects.toThrow(SeenInputConflictError);

    expect(store.owner(T1, 0)).toBe(BIP21_A); // unchanged
  });

  it('reports the conflicting outpoints on the error', async () => {
    store.seed(T1, 0, BIP21_A);

    const err = await claimSeenInputsForSession(BIP21_B, [{ txid: T1, vout: 0 }]).catch((e) => e);
    expect(err).toBeInstanceOf(SeenInputConflictError);
    expect([...err.conflicts]).toEqual([`${T1}:0`]);
  });

  it('is idempotent for the same session (crash/retry resume)', async () => {
    // Simulates a crash after the claim committed but before the PDK state
    // transition was saved: the re-claim must succeed.
    store.seed(T1, 0, BIP21_A);

    await expect(claimSeenInputsForSession(BIP21_A, [
      { txid: T1, vout: 0 },
      { txid: T2, vout: 1 },
    ])).resolves.toBeUndefined();

    expect(store.owner(T1, 0)).toBe(BIP21_A);
    expect(store.owner(T2, 1)).toBe(BIP21_A);
  });

  it('lets at most one of two concurrent claims of the same outpoint succeed', async () => {
    const results = await Promise.allSettled([
      claimSeenInputsForSession(BIP21_A, [{ txid: T1, vout: 0 }]),
      claimSeenInputsForSession(BIP21_B, [{ txid: T1, vout: 0 }]),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SeenInputConflictError);

    // The committed owner is the winner.
    const winner = results[0].status === 'fulfilled' ? BIP21_A : BIP21_B;
    expect(store.owner(T1, 0)).toBe(winner);
  });

  it('rolls back the whole multi-input claim on conflict (no partial claims)', async () => {
    store.seed(T2, 1, BIP21_B);

    await expect(claimSeenInputsForSession(BIP21_A, [
      { txid: T1, vout: 0 },
      { txid: T2, vout: 1 },
    ])).rejects.toThrow(SeenInputConflictError);

    expect(store.owner(T1, 0)).toBeUndefined(); // rolled back, not left behind
    expect(store.owner(T2, 1)).toBe(BIP21_B);
  });

  it('treats a legacy claim with a null owner as already seen', async () => {
    store.seed(T1, 0, null);

    await expect(claimSeenInputsForSession(BIP21_A, [{ txid: T1, vout: 0 }]))
      .rejects.toThrow(SeenInputConflictError);

    expect(store.owner(T1, 0)).toBeNull(); // poison claim untouched
  });

  it('propagates database failures instead of swallowing them (fail closed)', async () => {
    const dbError = new Error('connection refused');
    (db.$transaction as jest.Mock).mockRejectedValue(dbError);

    await expect(claimSeenInputsForSession(BIP21_A, [{ txid: T1, vout: 0 }]))
      .rejects.toBe(dbError);
  });

  it('is a no-op for an empty outpoint list', async () => {
    await expect(claimSeenInputsForSession(BIP21_A, [])).resolves.toBeUndefined();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('dedupes and sorts outpoints before inserting (deadlock avoidance)', async () => {
    await claimSeenInputsForSession(BIP21_A, [
      { txid: T2, vout: 1 },
      { txid: T1, vout: 5 },
      { txid: T1, vout: 0 },
      { txid: T1, vout: 5 }, // duplicate
    ]);

    expect(store.createManyData).toHaveLength(1);
    expect(store.createManyData[0].map(({ txid, vout }) => `${txid}:${vout}`)).toEqual([
      `${T1}:0`, `${T1}:5`, `${T2}:1`,
    ]);
  });
});

describe('outpointKey', () => {
  it('formats txid:vout and coerces bigint vout', () => {
    expect(outpointKey({ txid: T1, vout: 3 })).toBe(`${T1}:3`);
    expect(outpointKey({ txid: T1, vout: 7n })).toBe(`${T1}:7`);
  });
});
