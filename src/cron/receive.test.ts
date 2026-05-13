import { broadcastFallback } from './receive';
import { Receive } from '@prisma/client';
import { Config } from '../config';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('payjoin', () => ({ payjoin: {} }));

jest.mock('../lib/globals', () => ({
  cnClient: {
    decodeRawTransaction: jest.fn(),
    sendRawTransaction: jest.fn(),
  },
  syncCnClient: {},
  lock: { acquire: jest.fn((_keys: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../lib/db', () => ({
  db: {
    receive: { update: jest.fn().mockResolvedValue({ id: 1 }) },
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
const { db }       = require('../lib/db');

const mockConfig: Pick<Config, 'RECEIVE_WALLET'> = {
  RECEIVE_WALLET: '01',
};

const ORIGINAL_ADDRESS    = 'bc1qoriginaladdresspaidbysenderr';
const SUBSTITUTED_ADDRESS = 'bc1qsubstitutedaddressfreshutxo';
const FALLBACK_TX_HEX     = 'deadbeef01020304';
const FALLBACK_TXID       = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';
const FALLBACK_AMOUNT_BTC  = 0.001;    // 100 000 sats
const FALLBACK_AMOUNT_SATS = 100_000n;

function makeReceiveSess(overrides: Partial<Receive> = {}): Receive {
  return {
    id: 1,
    bip21: `bitcoin:${ORIGINAL_ADDRESS}?amount=0.001&pj=https://example.com`,
    address: ORIGINAL_ADDRESS,
    amount: FALLBACK_AMOUNT_SATS,
    receiverInAmount: null,
    receiverOutAmount: null,
    txid: null,
    fee: null,
    receiverFee: null,
    fallbackTxHex: FALLBACK_TX_HEX,
    callbackUrl: null,
    calledBackTs: null,
    expiryTs: null,
    cancelledTs: null,
    session: null,
    ohttpRelay: null,
    firstSeenTs: null,
    fallbackTs: null,
    nonPayjoinTs: null,
    confirmedTs: null,
    failedTs: null,
    failedReason: null,
    createdTs: new Date(),
    updatedTs: new Date(),
    ...overrides,
  };
}

/** The decoded fallback tx — sender always pays the ORIGINAL BIP21 address. */
function mockDecodedFallbackTx(receiverAddress: string = ORIGINAL_ADDRESS) {
  return {
    result: {
      tx: {
        txid: FALLBACK_TXID,
        hash: FALLBACK_TXID,
        version: 2,
        size: 200,
        vsize: 200,
        weight: 800,
        locktime: 0,
        vin: [],
        vout: [
          // sender's change output (not ours)
          {
            value: 0.009,
            n: 0,
            scriptPubKey: { asm: '', desc: '', hex: 'aa', type: 'witness_v0_keyhash', address: 'bc1qsenderschange' },
          },
          // the payment output — always pays the ORIGINAL BIP21 address
          {
            value: FALLBACK_AMOUNT_BTC,
            n: 1,
            scriptPubKey: { asm: '', desc: '', hex: 'bb', type: 'witness_v0_keyhash', address: receiverAddress },
          },
        ],
      },
    },
    error: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  cnClient.sendRawTransaction.mockResolvedValue({ result: FALLBACK_TXID, error: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broadcastFallback — output substitution address bug (SECURITY_REVIEW high finding)', () => {

  /**
   * GREEN anchor — the non-substituted case already works correctly.
   * This must pass before AND after the fix.
   */
  it('records correct amount when no output substitution occurred', async () => {
    // address in DB matches what the sender paid — no substitution happened
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));

    await broadcastFallback(
      makeReceiveSess({ address: ORIGINAL_ADDRESS }),
      mockConfig as Config,
    );

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.amount).toBe(FALLBACK_AMOUNT_SATS); // 100 000 sats ✓
    expect(updateArgs.data.txid).toBe(FALLBACK_TXID);
  });

  /**
   * RED TEST — proves the bug.
   *
   * When output substitution occurred, the DB record's `address` field was
   * updated to the new (substituted) address.  But the sender's fallback tx
   * still pays the ORIGINAL BIP21 address.
   *
   * broadcastFallback filters vouts by `receiveSess.address` (the substituted
   * one), finds no match, and records amount = 0n.
   *
   * This test asserts the CORRECT desired behaviour — it FAILS in the current
   * codebase, proving the gap exists.
   */
  it('records correct amount after fallback when output was substituted', async () => {
    // Fallback tx pays the ORIGINAL address (sender built it before substitution).
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));

    await broadcastFallback(
      // DB has the substituted address — simulates what happens after substitution.
      // bip21 still contains the original address, which is what the fix uses.
      makeReceiveSess({ address: SUBSTITUTED_ADDRESS }),
      mockConfig as Config,
    );

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.amount).toBe(FALLBACK_AMOUNT_SATS); // 100 000 sats ✓
    expect(updateArgs.data.txid).toBe(FALLBACK_TXID);
  });

});
