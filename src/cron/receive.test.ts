import { broadcastFallback, sumReceiverInputs, isKnownProbe } from './receive';
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

// ---------------------------------------------------------------------------
// isKnownProbe — probing detection
// ---------------------------------------------------------------------------

describe('isKnownProbe — probing detection with session-local map', () => {

  const BIP21_A = 'bitcoin:bc1qaaa?amount=0.001&pj=https://example.com';
  const BIP21_B = 'bitcoin:bc1qbbb?amount=0.001&pj=https://example.com';
  const outpoint = { txid: 'deadbeef', vout: 0n };

  it('returns false and records outpoint when never seen before', () => {
    const seenMap = new Map<string, string>();
    const newInputs = new Set<string>();

    const result = isKnownProbe(outpoint, BIP21_A, newInputs, seenMap);

    expect(result).toBe(false);
    expect(newInputs.has('deadbeef:0')).toBe(true);
  });

  it('returns false when outpoint was seen with the same BIP21', () => {
    const seenMap = new Map([['deadbeef:0', BIP21_A]]);
    const newInputs = new Set<string>();

    expect(isKnownProbe(outpoint, BIP21_A, newInputs, seenMap)).toBe(false);
  });

  it('returns false when outpoint was seen with no BIP21 recorded', () => {
    const seenMap = new Map([['deadbeef:0', '']]);
    const newInputs = new Set<string>();

    expect(isKnownProbe(outpoint, BIP21_A, newInputs, seenMap)).toBe(false);
  });

  it('returns true (probe detected) when outpoint was seen with a different BIP21', () => {
    // Input X was already used in session for BIP21_A.
    // Now a sender is presenting the same input for BIP21_B — classic probing attack.
    const seenMap = new Map([['deadbeef:0', BIP21_A]]);
    const newInputs = new Set<string>();

    expect(isKnownProbe(outpoint, BIP21_B, newInputs, seenMap)).toBe(true);
  });

  it('does not add outpoint to newInputs when it was already seen', () => {
    const seenMap = new Map([['deadbeef:0', BIP21_A]]);
    const newInputs = new Set<string>();

    isKnownProbe(outpoint, BIP21_A, newInputs, seenMap);

    expect(newInputs.size).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// sumReceiverInputs — outpoint matching
// ---------------------------------------------------------------------------

describe('sumReceiverInputs — receiver input matched by outpoint not scriptPubKey', () => {

  const SHARED_SCRIPT = 'aabbcc'; // same scriptPubKey on both UTXOs (address reuse)

  const vin = [
    { txid: 'aaaa', vout: 0 }, // sender input
    { txid: 'bbbb', vout: 1 }, // receiver contributed UTXO
    { txid: 'bbbb', vout: 2 }, // second UTXO at same address — NOT contributed
  ];

  const psbtInputs = [
    { witness_utxo: { amount: 0.5,    scriptPubKey: { hex: SHARED_SCRIPT } } }, // sender
    { witness_utxo: { amount: 0.001,  scriptPubKey: { hex: SHARED_SCRIPT } } }, // receiver contributed
    { witness_utxo: { amount: 0.0005, scriptPubKey: { hex: SHARED_SCRIPT } } }, // NOT contributed
  ];

  // Only bbbb:1 was contributed — value = 100 000 sats
  const contributedInputs = [{ txid: 'bbbb', vout: 1 }];

  it('counts only the contributed UTXO when address reuse exists', () => {
    const result = sumReceiverInputs(psbtInputs, vin, contributedInputs);
    expect(result).toBe(100_000n); // 0.001 BTC — only bbbb:1
  });

  it('returns 0n when no contributed inputs are in the PSBT', () => {
    const result = sumReceiverInputs(psbtInputs, vin, [{ txid: 'cccc', vout: 0 }]);
    expect(result).toBe(0n);
  });

  it('handles uppercase hex in scriptPubKey without silently returning 0', () => {
    // scriptPubKey hex returned by Bitcoin Core may be uppercase; outpoint matching
    // is unaffected by case — the old scriptPubKey comparison would silently fail.
    const upperCasePsbtInputs = psbtInputs.map(i => ({
      ...i,
      witness_utxo: { ...i.witness_utxo, scriptPubKey: { hex: SHARED_SCRIPT.toUpperCase() } },
    }));
    const result = sumReceiverInputs(upperCasePsbtInputs, vin, contributedInputs);
    expect(result).toBe(100_000n); // still correct — outpoint is case-insensitive
  });

});

describe('broadcastFallback — output substitution address bug', () => {

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

  it('returns early without broadcasting when fallbackTxHex is absent', async () => {
    await broadcastFallback(
      makeReceiveSess({ fallbackTxHex: null }),
      mockConfig as Config,
    );

    expect(cnClient.decodeRawTransaction).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('returns early without broadcasting when decodeRawTransaction fails', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue({ result: null, error: { code: -1, message: 'decode error' } });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('does not update db when sendRawTransaction fails', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));
    cnClient.sendRawTransaction.mockResolvedValue({ result: null, error: { code: -25, message: 'bad tx' } });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('uses receiveSess.address when bip21 is null', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));

    await broadcastFallback(
      makeReceiveSess({ bip21: null, address: ORIGINAL_ADDRESS }),
      mockConfig as Config,
    );

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.amount).toBe(FALLBACK_AMOUNT_SATS);
    expect(updateArgs.data.txid).toBe(FALLBACK_TXID);
  });

  it('sums multiple vouts that pay the receiver address', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue({
      result: {
        tx: {
          txid: FALLBACK_TXID,
          hash: FALLBACK_TXID,
          version: 2, size: 300, vsize: 300, weight: 1200, locktime: 0,
          vin: [],
          vout: [
            { value: FALLBACK_AMOUNT_BTC, n: 0, scriptPubKey: { asm: '', desc: '', hex: 'aa', type: 'p2wpkh', address: ORIGINAL_ADDRESS } },
            { value: FALLBACK_AMOUNT_BTC, n: 1, scriptPubKey: { asm: '', desc: '', hex: 'bb', type: 'p2wpkh', address: ORIGINAL_ADDRESS } },
          ],
        },
      },
      error: null,
    });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.amount).toBe(FALLBACK_AMOUNT_SATS * 2n); // both vouts summed
  });

  it('records 0n when no vout pays the receiver address', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue({
      result: {
        tx: {
          txid: FALLBACK_TXID,
          hash: FALLBACK_TXID,
          version: 2, size: 200, vsize: 200, weight: 800, locktime: 0,
          vin: [],
          vout: [
            { value: 0.5, n: 0, scriptPubKey: { asm: '', desc: '', hex: 'cc', type: 'p2wpkh', address: 'bc1qsomethingelse' } },
          ],
        },
      },
      error: null,
    });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.amount).toBe(0n);
  });

});
