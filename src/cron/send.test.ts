import { validateAndBroadcastPayjoinPsbt } from './send';
import { Config } from '../config';

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
  },
  syncCnClient: {
    syncGetAddressInfo: jest.fn().mockReturnValue({ result: { ismine: false }, error: null }),
  },
  lock: { acquire: jest.fn((_keys: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../lib/db', () => ({
  db: {
    send: { update: jest.fn().mockResolvedValue({}) },
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

const mockConfig: Pick<Config, 'SEND_WALLET' | 'OHTTP_RELAYS' | 'MAX_PAYJOIN_FEE_RATE'> = {
  SEND_WALLET: '01',
  OHTTP_RELAYS: ['https://relay.example.com'],
  MAX_PAYJOIN_FEE_RATE: 500, // sat/vbyte — reject anything above this in tests
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

  /**
   * RED TEST — this test documents the security gap and is expected to FAIL
   * until the fee-rate check is added.
   *
   * A receiver that uses an extremely high fee rate (e.g. 1 000 sat/vbyte when
   * the original was ~10 sat/vbyte) would cause the sender to pay far more in
   * fees than anticipated. The payjoin SDK allows this provided the absolute fee
   * increase is proportional to the receiver's contributed inputs.  Our code
   * currently has no second layer of defence: it signs and broadcasts the
   * proposal before inspecting the fee.
   *
   * The test asserts what SHOULD happen (broadcast is refused).  It will fail
   * in the current codebase, proving the gap exists.
   */
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

  /**
   * Verifies that fee inspection (decodePsbt) currently happens AFTER broadcast,
   * not before.  This directly documents the ordering bug: the fee check is
   * accounting-only, not a gate.
   */
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
