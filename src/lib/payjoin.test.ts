// ---------------------------------------------------------------------------
// Module mocks — prevent side-effectful imports from failing in test env
// ---------------------------------------------------------------------------

jest.mock('payjoin', () => ({ payjoin: {} }));
jest.mock('axios', () => ({ default: { get: jest.fn(), post: jest.fn(), request: jest.fn() }, isAxiosError: jest.fn() }));
jest.mock('https-proxy-agent', () => ({ HttpsProxyAgent: jest.fn() }));

jest.mock('./globals', () => ({
  cnClient: {},
  syncCnClient: {},
  lock: {},
}));

jest.mock('./db', () => ({
  db: {},
}));

jest.mock('./Log2File', () => ({
  __esModule: true,
  default: {
    silly: jest.fn(), trace: jest.fn(), debug: jest.fn(),
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  },
}));

jest.mock('./persister', () => ({
  ReceiverPersister: jest.fn(),
  SenderPersister: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { extractFeeFromPsbt, appendReceiveStatus, appendSendStatus, extractExpiry, describePayjoinError, extractReplyableError } from './payjoin';
import { ReceiveStatus, SendStatus } from '../types/payjoin';
import { Receive, Send } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceive(overrides: Partial<Receive> = {}): Receive {
  return {
    id: 1,
    bip21: 'bitcoin:bc1qtest?amount=0.001&pj=https://example.com',
    address: 'bc1qtest',
    amount: 100_000n,
    receiverInAmount: null,
    receiverOutAmount: null,
    senderInAmount: null,
    senderOutAmount: null,
    txInputs: null,
    txOutputs: null,
    txid: null,
    fee: null,
    receiverFee: null,
    fallbackTxHex: null,

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

function makeSend(overrides: Partial<Send> = {}): Send {
  return {
    id: 1,
    bip21: 'bitcoin:bc1qtest?amount=0.001&pj=https://example.com',
    amount: 100_000n,
    senderInAmount: null,
    senderOutAmount: null,
    receiverInAmount: null,
    receiverOutAmount: null,
    txInputs: null,
    txOutputs: null,
    txid: null,
    address: 'bc1qtest',
    fee: null,
    senderFee: null,
    callbackUrl: null,
    calledBackTs: null,
    expiryTs: null,
    cancelledTs: null,
    session: null,
    ohttpRelay: null,
    confirmedTs: null,
    createdTs: new Date(),
    updatedTs: new Date(),
    ...overrides,
  };
}

// Minimal decoded-PSBT structure for extractFeeFromPsbt
function makePsbt(overrides: {
  fee?: number;
  inputs?: Array<{ witness_utxo?: { amount: number; scriptPubKey: { asm: string; desc: string; hex: string; type: string } } }>;
  vout?: Array<{ value: number; n: number; scriptPubKey: { asm: string; desc: string; hex: string; reqSigs: number; type: string } }>;
}) {
  return {
    fee: overrides.fee,
    inputs: overrides.inputs ?? [],
    outputs: [],
    tx: {
      txid: 'abc',
      hash: 'abc',
      version: 2,
      size: 200,
      vsize: 200,
      weight: 800,
      locktime: 0,
      vin: [],
      vout: overrides.vout ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// extractFeeFromPsbt
// ---------------------------------------------------------------------------

describe('extractFeeFromPsbt', () => {

  it('returns the fee field in sats when present', () => {
    const psbt = makePsbt({ fee: 0.001 }); // 0.001 BTC = 100 000 sats
    expect(extractFeeFromPsbt(psbt as any)).toBe(100_000n);
  });

  it('calculates fee from inputs minus outputs when fee field is absent', () => {
    const scriptPubKey = { asm: '', desc: '', hex: '', reqSigs: 0, type: 'p2wpkh' };
    const psbt = makePsbt({
      inputs: [
        { witness_utxo: { amount: 0.1,  scriptPubKey: { asm: '', desc: '', hex: '', type: '' } } },
        { witness_utxo: { amount: 0.05, scriptPubKey: { asm: '', desc: '', hex: '', type: '' } } },
      ],
      vout: [
        { value: 0.14,   n: 0, scriptPubKey },
        { value: 0.0099, n: 1, scriptPubKey },
      ],
    });
    // totalIn = 15 000 000, totalOut = 14 990 000, fee = 10 000
    expect(extractFeeFromPsbt(psbt as any)).toBe(10_000n);
  });

  it('skips inputs without witness_utxo when calculating fee', () => {
    const scriptPubKey = { asm: '', desc: '', hex: '', reqSigs: 0, type: 'p2wpkh' };
    const psbt = makePsbt({
      inputs: [
        { witness_utxo: { amount: 0.5, scriptPubKey: { asm: '', desc: '', hex: '', type: '' } } },
        {},  // no witness_utxo — must be ignored
      ],
      vout: [{ value: 0.499, n: 0, scriptPubKey }],
    });
    // 50 000 000 - 49 900 000 = 100 000
    expect(extractFeeFromPsbt(psbt as any)).toBe(100_000n);
  });

  it('returns 0n when inputs exactly equal outputs (no fee)', () => {
    const scriptPubKey = { asm: '', desc: '', hex: '', reqSigs: 0, type: 'p2wpkh' };
    const psbt = makePsbt({
      inputs: [{ witness_utxo: { amount: 0.001, scriptPubKey: { asm: '', desc: '', hex: '', type: '' } } }],
      vout: [{ value: 0.001, n: 0, scriptPubKey }],
    });
    expect(extractFeeFromPsbt(psbt as any)).toBe(0n);
  });

  it('handles empty inputs and outputs (fee = 0n)', () => {
    const psbt = makePsbt({});
    expect(extractFeeFromPsbt(psbt as any)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// appendReceiveStatus
// ---------------------------------------------------------------------------

describe('appendReceiveStatus', () => {

  it('returns Cancelled when cancelledTs is set', () => {
    expect(appendReceiveStatus(makeReceive({ cancelledTs: new Date() })).status).toBe(ReceiveStatus.Cancelled);
  });

  it('returns Confirmed when confirmedTs is set', () => {
    expect(appendReceiveStatus(makeReceive({ confirmedTs: new Date() })).status).toBe(ReceiveStatus.Confirmed);
  });

  it('returns Fallback when fallbackTs is set', () => {
    expect(appendReceiveStatus(makeReceive({ txid: 'abc', fallbackTs: new Date() })).status).toBe(ReceiveStatus.Fallback);
  });

  it('returns NonPayjoin when nonPayjoinTs is set', () => {
    expect(appendReceiveStatus(makeReceive({ txid: 'abc', nonPayjoinTs: new Date() })).status).toBe(ReceiveStatus.NonPayjoin);
  });

  it('returns Unconfirmed when txid is set (no confirmation yet)', () => {
    expect(appendReceiveStatus(makeReceive({ txid: 'abc123' })).status).toBe(ReceiveStatus.Unconfirmed);
  });

  it('returns Expired when expiryTs is in the past and no txid', () => {
    const past = new Date(Date.now() - 10_000);
    expect(appendReceiveStatus(makeReceive({ expiryTs: past })).status).toBe(ReceiveStatus.Expired);
  });

  it('returns Pending when expiryTs is in the future and no txid', () => {
    const future = new Date(Date.now() + 10_000);
    expect(appendReceiveStatus(makeReceive({ expiryTs: future })).status).toBe(ReceiveStatus.Pending);
  });

  it('returns Pending when nothing is set', () => {
    expect(appendReceiveStatus(makeReceive()).status).toBe(ReceiveStatus.Pending);
  });

  it('Cancelled takes priority over Confirmed', () => {
    const result = appendReceiveStatus(makeReceive({ cancelledTs: new Date(), confirmedTs: new Date() }));
    expect(result.status).toBe(ReceiveStatus.Cancelled);
  });

  it('strips the session field from the returned object', () => {
    const result = appendReceiveStatus(makeReceive({ session: 'secret-session-data' }));
    expect(result).not.toHaveProperty('session');
  });

  it('preserves other fields on the returned object', () => {
    const result = appendReceiveStatus(makeReceive({ amount: 50_000n }));
    expect(result.amount).toBe(50_000n);
    expect(result.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// appendSendStatus
// ---------------------------------------------------------------------------

describe('appendSendStatus', () => {

  it('returns Cancelled when cancelledTs is set', () => {
    expect(appendSendStatus(makeSend({ cancelledTs: new Date() })).status).toBe(SendStatus.Cancelled);
  });

  it('returns Confirmed when confirmedTs is set', () => {
    expect(appendSendStatus(makeSend({ confirmedTs: new Date() })).status).toBe(SendStatus.Confirmed);
  });

  it('returns Unconfirmed when txid is set', () => {
    expect(appendSendStatus(makeSend({ txid: 'abc123' })).status).toBe(SendStatus.Unconfirmed);
  });

  it('returns Expired when expiryTs is in the past and no txid', () => {
    const past = new Date(Date.now() - 10_000);
    expect(appendSendStatus(makeSend({ expiryTs: past })).status).toBe(SendStatus.Expired);
  });

  it('returns Pending when expiryTs is in the future', () => {
    const future = new Date(Date.now() + 10_000);
    expect(appendSendStatus(makeSend({ expiryTs: future })).status).toBe(SendStatus.Pending);
  });

  it('returns Pending when nothing is set', () => {
    expect(appendSendStatus(makeSend()).status).toBe(SendStatus.Pending);
  });

  it('Cancelled takes priority over Confirmed', () => {
    const result = appendSendStatus(makeSend({ cancelledTs: new Date(), confirmedTs: new Date() }));
    expect(result.status).toBe(SendStatus.Cancelled);
  });

  it('strips the session field from the returned object', () => {
    const result = appendSendStatus(makeSend({ session: 'secret-session-data' }));
    expect(result).not.toHaveProperty('session');
  });
});

// ---------------------------------------------------------------------------
// extractExpiry
// ---------------------------------------------------------------------------

describe('extractExpiry', () => {

  it('returns null when the URL has no # fragment', () => {
    expect(extractExpiry('https://example.com/pj')).toBeNull();
  });

  it('returns null when the fragment contains no EX1 part', () => {
    expect(extractExpiry('https://example.com/pj#SOMEOTHERPARAM')).toBeNull();
  });

  it('returns null when EX1 data has fewer than 4 bytes', () => {
    // "EX1qq" → 2 data characters → only 2 bytes decoded → length < 4
    expect(extractExpiry('https://example.com/pj#EX1qq')).toBeNull();
  });

  it('returns null when EX1 encodes timestamp 0', () => {
    // "EX1qqqqqqq" → 7 zero words → [0,0,0,0] → decodeU32LE = 0 → null
    expect(extractExpiry('https://example.com/pj#EX1qqqqqqq')).toBeNull();
  });

  it('returns null when the bech32 data contains an invalid character', () => {
    // '!' is not in the bech32 charset — decodeBech32NoChecksum will throw
    expect(extractExpiry('https://example.com/pj#EX1!')).toBeNull();
  });

  it('extracts a valid timestamp from an EX1 fragment', () => {
    // "EX1qqqsqqq" decodes to LE bytes [0,1,0,0] → timestamp 256
    // Derivation: timestamp 256 = 0x00000100, LE = [0x00,0x01,0x00,0x00]
    // 5-bit groups (MSB-first): [0,0,0,16,0,0,0] → charset chars: "qqqsqqq"
    expect(extractExpiry('https://example.com/pj#EX1qqqsqqq')).toBe(256);
  });

  it('extracts timestamp when EX1 appears among dash-separated hash parts', () => {
    expect(extractExpiry('https://example.com/pj#PARAM1-EX1qqqsqqq-PARAM2')).toBe(256);
  });
});

describe('describePayjoinError', () => {
  it('returns message for a plain Error', () => {
    expect(describePayjoinError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-error value', () => {
    expect(describePayjoinError('just a string')).toBe('just a string');
    expect(describePayjoinError(42)).toBe('42');
  });

  it('extracts the inner WASM detail from a tagged uniffi error via toDebugString', () => {
    // Mirrors the ReceiverPersistedError.Storage shape thrown by the bindings:
    // `message` is just the variant name; the real detail lives in `inner`,
    // an opaque WASM object that JSON-serializes to {} but exposes toDebugString().
    const innerWasm = {
      toDebugString: () => 'Fatal error: Can\'t broadcast. PSBT rejected by mempool.',
      toString: () => 'Fatal error: Can\'t broadcast. PSBT rejected by mempool.',
    };
    const err = Object.assign(new Error('ReceiverPersistedError.Storage'), {
      name: 'ReceiverPersistedError',
      tag: 'Storage',
      inner: [innerWasm],
    });
    expect(describePayjoinError(err)).toBe(
      "ReceiverPersistedError.Storage: Fatal error: Can't broadcast. PSBT rejected by mempool."
    );
  });

  it('falls back to toString when toDebugString is absent', () => {
    const err = Object.assign(new Error('ReceiverPersistedError.Receiver'), {
      name: 'ReceiverPersistedError',
      tag: 'Receiver',
      inner: [{ toString: () => 'protocol: original psbt rejected' }],
    });
    expect(describePayjoinError(err)).toBe(
      'ReceiverPersistedError.Receiver: protocol: original psbt rejected'
    );
  });

  it('returns just name.tag when the inner detail is an opaque {} handle', () => {
    const err = Object.assign(new Error('ReceiverPersistedError.Storage'), {
      name: 'ReceiverPersistedError',
      tag: 'Storage',
      inner: [{}],
    });
    expect(describePayjoinError(err)).toBe('ReceiverPersistedError.Storage');
  });
});

describe('extractReplyableError', () => {
  // Session events are stored as an array of JSON-encoded strings.
  const ev = (o: unknown) => JSON.stringify(o);

  it('returns undefined for null/empty/invalid input', () => {
    expect(extractReplyableError(null)).toBeUndefined();
    expect(extractReplyableError(undefined)).toBeUndefined();
    expect(extractReplyableError('')).toBeUndefined();
    expect(extractReplyableError('not json')).toBeUndefined();
    expect(extractReplyableError('{"not":"an array"}')).toBeUndefined();
  });

  it('returns undefined when no GotReplyableError event is present', () => {
    const session = JSON.stringify([ev({ Created: {} }), ev({ RetrievedOriginalPayload: {} })]);
    expect(extractReplyableError(session)).toBeUndefined();
  });

  it('extracts error_code and message from a GotReplyableError event', () => {
    const session = JSON.stringify([
      ev({ Created: {} }),
      ev({ GotReplyableError: { error_code: 'OriginalPsbtRejected', message: "Can't broadcast. PSBT rejected by mempool.", extra: {} } }),
      ev({ Closed: 'Failure' }),
    ]);
    expect(extractReplyableError(session)).toBe("OriginalPsbtRejected: Can't broadcast. PSBT rejected by mempool.");
  });

  it('returns the most recent GotReplyableError when several are present', () => {
    const session = JSON.stringify([
      ev({ GotReplyableError: { error_code: 'First', message: 'first error' } }),
      ev({ GotReplyableError: { error_code: 'Second', message: 'second error' } }),
    ]);
    expect(extractReplyableError(session)).toBe('Second: second error');
  });

  it('falls back to message alone or error_code alone', () => {
    expect(extractReplyableError(JSON.stringify([JSON.stringify({ GotReplyableError: { message: 'only message' } })]))).toBe('only message');
    expect(extractReplyableError(JSON.stringify([JSON.stringify({ GotReplyableError: { error_code: 'OnlyCode' } })]))).toBe('OnlyCode');
  });

  it('tolerates already-parsed object events', () => {
    const session = JSON.stringify([{ GotReplyableError: { error_code: 'C', message: 'm' } }]);
    expect(extractReplyableError(session)).toBe('C: m');
  });
});
