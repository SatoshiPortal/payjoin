import { validateAndBroadcastPayjoinPsbt, restoreSendSessions } from './send';
import { Config } from '../config';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// payjoin is an ESM package — mock it so Jest can parse send.ts without issues.
// validateAndBroadcastPayjoinPsbt doesn't use the SDK at all, so an empty mock
// is sufficient for these tests.
jest.mock('payjoin', () => ({ payjoin: { replaySenderEventLog: jest.fn() } }));

jest.mock('../lib/globals', () => ({
  cnClient: {
    processPsbt: jest.fn(),
    finalizePsbt: jest.fn(),
    sendRawTransaction: jest.fn(),
    decodePsbt: jest.fn(),
    decodeRawTransaction: jest.fn(),
    getTransaction: jest.fn(),
    testMempoolAccept: jest.fn(),
    lockUnspent: jest.fn(),
  },
  syncCnClient: {
    syncGetAddressInfo: jest.fn().mockReturnValue({ result: { ismine: false }, error: null }),
  },
  lock: { acquire: jest.fn((_keys: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../lib/db', () => ({
  db: {
    send: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
}));

// only reached by recoverFallbackTxHex(), for rows predating fallbackTxHex
jest.mock('../lib/persister', () => ({
  SenderPersister: jest.fn().mockImplementation(() => ({ restore: jest.fn() })),
}));

jest.mock('../lib/Log2File', () => ({
  __esModule: true,
  default: {
    silly: jest.fn(), trace: jest.fn(), debug: jest.fn(),
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnClient } = require('../lib/globals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('../lib/db');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { payjoin: payjoinSdk } = require('payjoin');

const mockConfig: Pick<Config, 'SEND_WALLET' | 'OHTTP_RELAYS' | 'MAX_PAYJOIN_FEE_RATE' | 'RESERVATION_RELEASE_GRACE'> = {
  SEND_WALLET: '01',
  OHTTP_RELAYS: ['https://relay.example.com'],
  MAX_PAYJOIN_FEE_RATE: 500, // sat/vbyte — reject anything above this in tests
  RESERVATION_RELEASE_GRACE: 1800, // 30m
};

const mockSendSess = { id: 1, amount: 100_000n }; // 100k sat payment

// Fake but structurally-valid PSBT strings (contents irrelevant — cnClient is mocked).
const PROPOSAL_PSBT = 'cHNidP8BAH0CAAAAA...proposal';
const SIGNED_PSBT   = 'cHNidP8BAH0CAAAAA...signed';
const TX_HEX        = 'deadbeef01020304';
const FAKE_TXID     = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';
// the sender's signed original, stored at createSender() time
const FALLBACK_HEX  = '0200000001aabbccdd00000000';
const FALLBACK_TXID = 'beef5678beef5678beef5678beef5678beef5678beef5678beef5678beef5678';

/**
 * Set up the happy-path chain of cnClient mocks.
 * @param feeRateSatVbyte - the fee rate to report in the pre-sign decodePsbt call (sat/vbyte)
 * @param vsizeVbytes     - the vsize to report for the proposal transaction
 */
function setupMocks(feeRateSatVbyte: number, vsizeVbytes = 200) {
  const feeSats = feeRateSatVbyte * vsizeVbytes;
  const feeBtc  = feeSats / 1e8;

  const decodedPsbt = {
    result: {
      fee: feeBtc,
      inputs: [],
      outputs: [],
      tx: {
        txid: FAKE_TXID,
        hash: FAKE_TXID,
        version: 2,
        size: vsizeVbytes,
        vsize: vsizeVbytes,
        weight: vsizeVbytes * 4,
        locktime: 0,
        vin: [],
        vout: [],
      },
    },
    error: null,
  };

  cnClient.decodePsbt.mockResolvedValue(decodedPsbt);
  cnClient.processPsbt.mockResolvedValue({ result: { psbt: SIGNED_PSBT, complete: true }, error: null });
  cnClient.finalizePsbt.mockResolvedValue({ result: { hex: TX_HEX, psbt: SIGNED_PSBT }, error: null });
  cnClient.sendRawTransaction.mockResolvedValue({ result: FAKE_TXID, error: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => jest.clearAllMocks());

describe('validateAndBroadcastPayjoinPsbt — fee-rate guard', () => {

  it('rejects proposal when fee rate exceeds MAX_PAYJOIN_FEE_RATE', async () => {
    // 1 000 sat/vbyte × 200 vbytes = 200 000 sats in fees on a 100 000 sat payment — 2× the payment amount
    setupMocks(1_000);

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  /**
   * GREEN TEST — normal fee rate should always result in broadcast.
   * This must pass both before and after the fix.
   */
  it('broadcasts proposal when fee rate is reasonable', async () => {
    // 10 sat/vbyte × 200 vbytes = 2 000 sats on a 100 000 sat payment — 2 %
    setupMocks(10);

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.processPsbt).toHaveBeenCalledWith(
      expect.objectContaining({ psbt: PROPOSAL_PSBT, sign: true, finalize: true }),
    );
    expect(cnClient.sendRawTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ hex: TX_HEX }),
    );
  });

  it('decodes proposal PSBT before signing and broadcasts in correct order', async () => {
    setupMocks(10);
    const callOrder: string[] = [];

    cnClient.decodePsbt.mockImplementation(async () => {
      callOrder.push('decodePsbt');
      return { result: { fee: 0.000002, inputs: [], outputs: [], tx: { txid: FAKE_TXID, hash: FAKE_TXID, version: 2, size: 200, vsize: 200, weight: 800, locktime: 0, vin: [], vout: [] } }, error: null };
    });
    cnClient.processPsbt.mockImplementation(async () => {
      callOrder.push('processPsbt');
      return { result: { psbt: SIGNED_PSBT, complete: true }, error: null };
    });
    cnClient.finalizePsbt.mockImplementation(async () => {
      callOrder.push('finalizePsbt');
      return { result: { hex: TX_HEX, psbt: SIGNED_PSBT }, error: null };
    });
    cnClient.sendRawTransaction.mockImplementation(async () => {
      callOrder.push('sendRawTransaction');
      return { result: FAKE_TXID, error: null };
    });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(callOrder).toEqual(['decodePsbt', 'processPsbt', 'finalizePsbt', 'sendRawTransaction']);
  });
});

// ---------------------------------------------------------------------------
// Error paths — each step can abort the pipeline independently
// ---------------------------------------------------------------------------

describe('validateAndBroadcastPayjoinPsbt — error paths', () => {

  it('returns early without signing when decodePsbt returns an error', async () => {
    cnClient.decodePsbt.mockResolvedValue({ result: null, error: { code: -1, message: 'decode failed' } });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.processPsbt).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns early without signing when decodePsbt returns null result', async () => {
    cnClient.decodePsbt.mockResolvedValue({ result: null, error: null });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.processPsbt).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns early without finalizing when processPsbt returns an error', async () => {
    setupMocks(10);
    cnClient.processPsbt.mockResolvedValue({ result: null, error: { code: -1, message: 'process failed' } });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.finalizePsbt).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns early without finalizing when processPsbt returns complete=false', async () => {
    setupMocks(10);
    cnClient.processPsbt.mockResolvedValue({ result: { psbt: SIGNED_PSBT, complete: false }, error: null });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.finalizePsbt).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns early without broadcasting when finalizePsbt returns an error', async () => {
    setupMocks(10);
    cnClient.finalizePsbt.mockResolvedValue({ result: null, error: { code: -1, message: 'finalize failed' } });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns early without broadcasting when finalizePsbt returns no hex', async () => {
    setupMocks(10);
    cnClient.finalizePsbt.mockResolvedValue({ result: { hex: null, psbt: SIGNED_PSBT }, error: null });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('does not update db when sendRawTransaction returns an error', async () => {
    setupMocks(10);
    cnClient.sendRawTransaction.mockResolvedValue({ result: null, error: { code: -26, message: 'insufficient fee' } });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(db.send.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success path — db record updated with txid and accounting figures
// ---------------------------------------------------------------------------

describe('validateAndBroadcastPayjoinPsbt — success accounting', () => {

  it('updates db.send with txid and fee after a successful broadcast', async () => {
    // 10 sat/vbyte × 200 vbytes = 2 000 sats total fee (0.00002 BTC)
    setupMocks(10);

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(db.send.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          txid: FAKE_TXID,
          fee: 2_000n,      // extractFeeFromPsbt(0.00002 BTC)
          senderFee: 0n,    // no owned addresses in mock → rawFee < 0 → clamped to 0
          senderInAmount: 0n,
          senderOutAmount: 0n,
        }),
      }),
    );
  });

  it('does not update db when sendRawTransaction returns null txid', async () => {
    setupMocks(10);
    cnClient.sendRawTransaction.mockResolvedValue({ result: null, error: null });

    await validateAndBroadcastPayjoinPsbt(PROPOSAL_PSBT, mockSendSess, mockConfig as Config);

    expect(db.send.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restoreSendSessions — precise release of send-side wallet locks
//
// createFundedPsbt's lockUnspents:true has no matching release anywhere else
// (unlike the receive side's issue #8 mechanism). These tests cover the
// targeted release: exactly the outpoints recorded on a terminal (cancelled
// or expired), never-broadcast row — never a blanket wallet-wide unlock.
// ---------------------------------------------------------------------------

describe('restoreSendSessions — precise release of stuck locked inputs', () => {

  const LOCKED = [{ txid: 'a'.repeat(64), vout: 0 }, { txid: 'b'.repeat(64), vout: 1 }];

  // Cancelled rows take the pure-release path (never broadcast), which is what
  // this block is about — the expiry/fallback path has its own block below.
  function cancelledRow(id: number, lockedInputs: unknown) {
    return { id, lockedInputs, cancelledTs: new Date(), txid: null, address: 'bc1qsender', session: null, fallbackTxHex: null };
  }

  // first findMany call = active sessions to restore (always empty here, so
  // processSendSession/the payjoin SDK is never touched); second call = the
  // stuck-sends sweep. processTerminalSend re-reads each row under the lock,
  // so findUnique must resolve the same rows by id.
  function mockStuckSends(rows: Array<Record<string, unknown> & { id: number }>) {
    db.send.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows);
    db.send.findUnique.mockImplementation(
      ({ where }: { where: { id: number } }) => Promise.resolve(rows.find(r => r.id === where.id) ?? null)
    );
  }

  it('scopes the sweep query to unbroadcast, terminal rows with recorded locked inputs', async () => {
    mockStuckSends([]);

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.findMany).toHaveBeenLastCalledWith({
      where: {
        lockedInputs: { not: Prisma.DbNull },
        OR: [{ cancelledTs: { not: null } }, { expiryTs: { lte: expect.any(Date) } }],
      },
    });
  });

  it('only treats a send as expired-and-releasable once RESERVATION_RELEASE_GRACE has passed since expiry — cancellation still releases immediately with no grace', async () => {
    mockStuckSends([]);
    const before = Date.now();

    await restoreSendSessions(mockConfig as Config);

    const { where } = db.send.findMany.mock.calls[db.send.findMany.mock.calls.length - 1][0];
    const [cancelledClause, expiryClause] = where.OR;
    expect(cancelledClause).toEqual({ cancelledTs: { not: null } });

    // the expiry cutoff must be ~RESERVATION_RELEASE_GRACE seconds in the past
    // (not "now") — an expired session within the grace window must NOT match
    const cutoff = expiryClause.expiryTs.lte.getTime();
    const expectedCutoff = before - mockConfig.RESERVATION_RELEASE_GRACE * 1000;
    expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(2000); // small tolerance for test execution time
  });

  it('releases exactly the recorded outpoints for a stuck send, then clears lockedInputs', async () => {
    mockStuckSends([cancelledRow(42, LOCKED)]);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith({
      unlock: true,
      utxos: LOCKED,
      wallet: mockConfig.SEND_WALLET,
    });
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lockedInputs: Prisma.DbNull },
    });
  });

  it('never issues a blanket unlock — always passes the specific utxos array', async () => {
    mockStuckSends([cancelledRow(42, LOCKED)]);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });

    await restoreSendSessions(mockConfig as Config);

    const call = cnClient.lockUnspent.mock.calls[0][0];
    expect(call.utxos).not.toEqual([]);
    expect(call.utxos.length).toBeGreaterThan(0);
  });

  it('retries next cycle without clearing lockedInputs when lockUnspent fails', async () => {
    mockStuckSends([cancelledRow(42, LOCKED)]);
    cnClient.lockUnspent.mockResolvedValue({ result: null, error: { code: -1, message: 'rpc error' } });

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.update).not.toHaveBeenCalled();
  });

  // These locks are non-persistent, and the whole conflict path unlocks inputs
  // a competing tx already spent — both make Core refuse the unlock. Retrying
  // a lock that can never be taken again would strand the row forever.
  it.each([
    ['Invalid parameter, expected unspent output'],
    ['Invalid parameter, expected locked output'],
  ])('counts an already-gone outpoint (%s) as released', async (message) => {
    mockStuckSends([cancelledRow(42, LOCKED)]);
    cnClient.lockUnspent.mockResolvedValue({ result: null, error: { code: -32603, message } });

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lockedInputs: Prisma.DbNull },
    });
  });

  it('releases multiple stuck sends independently, each with its own outpoints', async () => {
    const otherLocked = [{ txid: 'c'.repeat(64), vout: 3 }];
    mockStuckSends([
      cancelledRow(42, LOCKED),
      cancelledRow(43, otherLocked),
    ]);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledTimes(2);
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ utxos: LOCKED }));
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ utxos: otherLocked }));
    expect(db.send.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { lockedInputs: Prisma.DbNull } });
    expect(db.send.update).toHaveBeenCalledWith({ where: { id: 43 }, data: { lockedInputs: Prisma.DbNull } });
  });

  it('skips a row with no locked inputs recorded (malformed/empty) without calling lockUnspent', async () => {
    mockStuckSends([cancelledRow(42, [])]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('does nothing when there are no stuck sends', async () => {
    mockStuckSends([]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('never broadcasts for a cancelled send — the user asked for the payment not to happen', async () => {
    mockStuckSends([{ ...cancelledRow(42, LOCKED), fallbackTxHex: FALLBACK_HEX }]);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
  });
});

// ---------------------------------------------------------------------------
// The reason this sweep exists: we hand the receiver a signed original and
// rely on them to broadcast it when the payjoin fails. Receiver wallets do not
// reliably do that, so before giving the inputs back we ask Cyphernode whether
// anything spending them ever reached the network, and broadcast it ourselves
// if not.
// ---------------------------------------------------------------------------

describe('processTerminalSend — fallback broadcast before releasing locks', () => {

  const LOCKED = [{ txid: 'a'.repeat(64), vout: 0 }];

  function expiredRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 42,
      lockedInputs: LOCKED,
      cancelledTs: null,
      expiryTs: new Date(Date.now() - 7200 * 1000),
      txid: null,
      address: 'bc1qsender',
      session: null,
      fallbackTxHex: FALLBACK_HEX,
      ...overrides,
    };
  }

  function mockSweep(rows: Array<Record<string, unknown>>) {
    db.send.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    db.send.findUnique.mockImplementation(
      ({ where }: { where: { id: number } }) => Promise.resolve(rows.find(r => r.id === where.id) ?? null)
    );
  }

  // bitcoind's "No such mempool or blockchain transaction"
  const NOT_FOUND = { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } };

  beforeEach(() => {
    cnClient.decodeRawTransaction.mockResolvedValue({ result: { tx: { txid: FALLBACK_TXID } }, error: null });
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });
    // nothing else spends the inputs unless a test says otherwise
    cnClient.testMempoolAccept.mockResolvedValue({ result: [{ txid: FALLBACK_TXID, allowed: true }], error: null });
  });

  it('broadcasts the stored original when Cyphernode knows of no such tx, and records it as a fallback', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.sendRawTransaction.mockResolvedValue({ result: FALLBACK_TXID, error: null });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).toHaveBeenCalledWith({
      hex: FALLBACK_HEX,
      wallet: mockConfig.SEND_WALLET,
    });
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { txid: FALLBACK_TXID, fallbackTs: expect.any(Date), lockedInputs: Prisma.DbNull },
    });
    // the inputs are spent by the broadcast — no unlock needed
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
  });

  it('does not broadcast when the tx is already on the network — records it and leaves the locks to the spend', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue({ result: { txid: FALLBACK_TXID, confirmations: 0 }, error: null });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { txid: FALLBACK_TXID, fallbackTs: expect.any(Date), lockedInputs: Prisma.DbNull },
    });
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
  });

  // The txid lookup only ever asks about OUR original. If the receiver
  // broadcast the payjoin and the watch callback has not caught up, that tx's
  // txid is unknown to us — testmempoolaccept is what surfaces it.
  it('detects a conflicting tx we have no txid for and releases instead of broadcasting', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({
      result: [{ txid: FALLBACK_TXID, allowed: false, 'reject-reason': 'txn-mempool-conflict' }],
      error: null,
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
    expect(db.send.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { lockedInputs: Prisma.DbNull } });
  });

  it('detects inputs spent by a confirmed tx via missing-inputs and releases without broadcasting', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({
      result: [{ txid: FALLBACK_TXID, allowed: false, 'reject-reason': 'missing-inputs' }],
      error: null,
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
  });

  it('records rather than rebroadcasts when the node already knows the original', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({
      result: [{ txid: FALLBACK_TXID, allowed: false, 'reject-reason': 'txn-already-in-mempool' }],
      error: null,
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { txid: FALLBACK_TXID, fallbackTs: expect.any(Date), lockedInputs: Prisma.DbNull },
    });
  });

  it('defers when the mempool-acceptance test itself fails — keeps the locks', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({ result: null, error: { code: -32603, message: 'ECONNREFUSED' } });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  // Core reaches "insufficient fee" only on the replacement path, so it means
  // a conflicting tx already holds these inputs — it reads like a fee problem
  // but deferring on it retries a doomed broadcast forever. This is the exact
  // reject-reason regtest produced for a conflicted send.
  it.each([
    ['insufficient fee'],
    ['insufficient fee, rejecting replacement 6f1a; new feerate 1.00 BTC/kvB <= old feerate 2.00 BTC/kvB'],
  ])('treats %# "insufficient fee" as a conflict, not a transient fee failure', async (reason) => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({
      result: [{ txid: FALLBACK_TXID, allowed: false, 'reject-reason': reason }],
      error: null,
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
    expect(db.send.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { lockedInputs: Prisma.DbNull } });
  });

  it('defers on a non-conflict rejection such as a fee-policy failure', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.testMempoolAccept.mockResolvedValue({
      result: [{ txid: FALLBACK_TXID, allowed: false, 'reject-reason': 'min relay fee not met' }],
      error: null,
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('defers on an ambiguous lookup failure: no broadcast, no release, no DB write — retried next cycle', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue({ result: null, error: { code: -32603, message: 'connect ECONNREFUSED' } });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('releases the locks when the inputs are already spent by a conflicting tx', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -25, message: 'bad-txns-inputs-missingorspent' },
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
    expect(db.send.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { lockedInputs: Prisma.DbNull } });
  });

  it('records the send when the broadcast races the receiver and loses (already known)', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -27, message: 'Transaction already in block chain' },
    });

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { txid: FALLBACK_TXID, fallbackTs: expect.any(Date), lockedInputs: Prisma.DbNull },
    });
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
  });

  it('keeps the locks and retries next cycle on a transient broadcast failure', async () => {
    mockSweep([expiredRow()]);
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -26, message: 'min relay fee not met' },
    });

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('releases without broadcasting when no fallback tx can be recovered at all', async () => {
    mockSweep([expiredRow({ fallbackTxHex: null, session: null })]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).toHaveBeenCalledWith(expect.objectContaining({ unlock: true, utxos: LOCKED }));
  });

  it('recovers the fallback tx from the SDK session history for rows written before fallbackTxHex existed', async () => {
    mockSweep([expiredRow({ fallbackTxHex: null, session: '[]' })]);
    // 0xde 0xad 0xbe 0xef
    const fallbackBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    payjoinSdk.replaySenderEventLog.mockReturnValue({
      sessionHistory: () => ({ fallbackTx: () => fallbackBytes }),
    });
    cnClient.getTransaction.mockResolvedValue(NOT_FOUND);
    cnClient.sendRawTransaction.mockResolvedValue({ result: FALLBACK_TXID, error: null });

    await restoreSendSessions(mockConfig as Config);

    // persisted so the next cycle does not have to replay the event log
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { fallbackTxHex: 'deadbeef' },
    });
    expect(cnClient.sendRawTransaction).toHaveBeenCalledWith({
      hex: 'deadbeef',
      wallet: mockConfig.SEND_WALLET,
    });
  });

  it('never re-broadcasts or unlocks a send whose tx already landed — only clears the stale lock record', async () => {
    // a payjoin txid, not our original
    mockSweep([expiredRow({ txid: 'f'.repeat(64) })]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lockedInputs: Prisma.DbNull },
    });
  });

  // The case the whole feature is about when the receiver DOES do its job: the
  // address watch records the txid without knowing whose tx it is, so without
  // this the payment would be reported as an ordinary send.
  it('labels a receiver-broadcast original as a fallback when the watch callback recorded it first', async () => {
    mockSweep([expiredRow({ txid: FALLBACK_TXID })]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lockedInputs: Prisma.DbNull, fallbackTs: expect.any(Date) },
    });
  });

  it('does not re-stamp fallbackTs on a send already marked as a fallback', async () => {
    mockSweep([expiredRow({ txid: FALLBACK_TXID, fallbackTs: new Date() })]);

    await restoreSendSessions(mockConfig as Config);

    expect(cnClient.decodeRawTransaction).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lockedInputs: Prisma.DbNull },
    });
  });
});
