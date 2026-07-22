import { validateAndBroadcastPayjoinPsbt, restoreSendSessions } from './send';
import { Config } from '../config';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// payjoin is an ESM package — mock it so Jest can parse send.ts without issues.
// validateAndBroadcastPayjoinPsbt doesn't use the SDK at all, so an empty mock
// is sufficient for these tests.
jest.mock('payjoin', () => ({ payjoin: {} }));

jest.mock('../lib/globals', () => ({
  cnClient: {
    processPsbt: jest.fn(),
    finalizePsbt: jest.fn(),
    sendRawTransaction: jest.fn(),
    decodePsbt: jest.fn(),
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
    },
  },
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

  // first findMany call = active sessions to restore (always empty here, so
  // processSendSession/the payjoin SDK is never touched); second call = the
  // stuck-sends release query.
  function mockStuckSends(rows: Array<{ id: number; lockedInputs: unknown }>) {
    db.send.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows);
  }

  it('scopes the release query to unbroadcast, terminal rows with recorded locked inputs', async () => {
    mockStuckSends([]);

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.findMany).toHaveBeenLastCalledWith({
      where: {
        txid: null,
        lockedInputs: { not: Prisma.DbNull },
        OR: [{ cancelledTs: { not: null } }, { expiryTs: { lte: expect.any(Date) } }],
      },
      select: { id: true, lockedInputs: true },
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
    mockStuckSends([{ id: 42, lockedInputs: LOCKED }]);
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
    mockStuckSends([{ id: 42, lockedInputs: LOCKED }]);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true }, error: null });

    await restoreSendSessions(mockConfig as Config);

    const call = cnClient.lockUnspent.mock.calls[0][0];
    expect(call.utxos).not.toEqual([]);
    expect(call.utxos.length).toBeGreaterThan(0);
  });

  it('retries next cycle without clearing lockedInputs when lockUnspent fails', async () => {
    mockStuckSends([{ id: 42, lockedInputs: LOCKED }]);
    cnClient.lockUnspent.mockResolvedValue({ result: null, error: { code: -1, message: 'rpc error' } });

    await restoreSendSessions(mockConfig as Config);

    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('releases multiple stuck sends independently, each with its own outpoints', async () => {
    const otherLocked = [{ txid: 'c'.repeat(64), vout: 3 }];
    mockStuckSends([
      { id: 42, lockedInputs: LOCKED },
      { id: 43, lockedInputs: otherLocked },
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
    mockStuckSends([{ id: 42, lockedInputs: [] }]);

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
});
