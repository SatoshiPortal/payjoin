// ---------------------------------------------------------------------------
// Module mocks — prevent side-effectful imports from failing in test env
// ---------------------------------------------------------------------------

jest.mock('payjoin', () => ({
  payjoin: {
    // createSender() does `new payjoin.SenderBuilder(psbt, pjUri).buildRecommended(1n).save(persister)`
    SenderBuilder: jest.fn().mockImplementation(() => ({
      buildRecommended: jest.fn().mockReturnThis(),
      save: jest.fn(),
    })),
  },
}));
jest.mock('axios', () => ({ default: { get: jest.fn(), post: jest.fn(), request: jest.fn() }, isAxiosError: jest.fn() }));
jest.mock('https-proxy-agent', () => ({ HttpsProxyAgent: jest.fn() }));

jest.mock('./globals', () => ({
  cnClient: {
    getFeeRate: jest.fn(),
    getblockchaininfo: jest.fn(),
    createFundedPsbt: jest.fn(),
    decodePsbt: jest.fn(),
    processPsbt: jest.fn(),
  },
  syncCnClient: {},
  lock: {},
}));

jest.mock('./db', () => ({
  db: {
    send: { update: jest.fn().mockResolvedValue({}) },
  },
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

import { extractFeeFromPsbt, appendReceiveStatus, appendSendStatus, extractExpiry, describePayjoinError, extractReplyableError, extractCommittedInputs, sessionHasPostedProposal, createSender } from './payjoin';
import { ReceiveStatus, SendStatus } from '../types/payjoin';
import { Receive, Send } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnClient } = require('./globals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('./db');

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
    fallbackAbandonedTs: null,
    reservedInputTxid: null,
    reservedInputVout: null,
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
    lockedInputs: null,
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

  it('returns Unconfirmed when txid is set and the tx has been seen on the network', () => {
    expect(appendReceiveStatus(makeReceive({ txid: 'abc123', firstSeenTs: new Date() })).status).toBe(ReceiveStatus.Unconfirmed);
  });

  it('returns Pending when txid is only the posted proposal and tx not yet seen', () => {
    const future = new Date(Date.now() + 10_000);
    expect(appendReceiveStatus(makeReceive({ txid: 'abc123', expiryTs: future })).status).toBe(ReceiveStatus.Pending);
  });

  it('returns Expired when expiryTs is in the past and no txid', () => {
    const past = new Date(Date.now() - 10_000);
    expect(appendReceiveStatus(makeReceive({ expiryTs: past })).status).toBe(ReceiveStatus.Expired);
  });

  it('returns Expired when the posted proposal was never seen and the session expired', () => {
    const past = new Date(Date.now() - 10_000);
    expect(appendReceiveStatus(makeReceive({ txid: 'abc123', expiryTs: past })).status).toBe(ReceiveStatus.Expired);
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

// ---------------------------------------------------------------------------
// extractCommittedInputs — committed receiver input recovered from session log
// ---------------------------------------------------------------------------

describe('extractCommittedInputs', () => {

  const TXID = 'a'.repeat(64);
  const ev = (obj: unknown) => JSON.stringify(obj);

  const commitEvent = (prevouts: string[]) => ev({
    CommittedInputs: prevouts.map((previous_output) => ({
      txin: { previous_output, script_sig: '', sequence: 0, witness: [] },
      psbtin: { witness_utxo: { value: 100000, script_pubkey: 'bb' } },
      expected_weight: 272,
    })),
  });

  it('returns the outpoint from a CommittedInputs event', () => {
    const events = [ev({ Created: {} }), commitEvent([`${TXID}:1`])];
    expect(extractCommittedInputs(events)).toEqual([{ txid: TXID, vout: 1 }]);
  });

  it('returns undefined when inputs were never committed', () => {
    expect(extractCommittedInputs([ev({ Created: {} })])).toBeUndefined();
    expect(extractCommittedInputs([])).toBeUndefined();
  });

  it('returns all outpoints of a multi-input commit', () => {
    const other = 'b'.repeat(64);
    expect(extractCommittedInputs([commitEvent([`${TXID}:0`, `${other}:3`])]))
      .toEqual([{ txid: TXID, vout: 0 }, { txid: other, vout: 3 }]);
  });

  it('uses the most recent CommittedInputs event', () => {
    const other = 'c'.repeat(64);
    const events = [commitEvent([`${TXID}:0`]), commitEvent([`${other}:2`])];
    expect(extractCommittedInputs(events)).toEqual([{ txid: other, vout: 2 }]);
  });

  it('tolerates already-parsed object events', () => {
    const events = [{ CommittedInputs: [{ txin: { previous_output: `${TXID}:5` } }] }];
    expect(extractCommittedInputs(events)).toEqual([{ txid: TXID, vout: 5 }]);
  });

  it('fails loudly (undefined) on an unexpected outpoint shape', () => {
    // struct-shaped previous_output (non-human-readable serde) must not be silently dropped
    const events = [ev({ CommittedInputs: [{ txin: { previous_output: { txid: TXID, vout: 1 } } }] })];
    expect(extractCommittedInputs(events)).toBeUndefined();
    // malformed txid
    expect(extractCommittedInputs([commitEvent(['nothex:1'])])).toBeUndefined();
    // missing vout
    expect(extractCommittedInputs([commitEvent([TXID])])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sessionHasPostedProposal
// ---------------------------------------------------------------------------

describe('sessionHasPostedProposal', () => {
  it('detects a posted proposal event regardless of JSON escaping depth', () => {
    const session = JSON.stringify([JSON.stringify({ PostedPayjoinProposal: [] })]);
    expect(sessionHasPostedProposal(session)).toBe(true);
  });

  it('is false for sessions that never posted', () => {
    expect(sessionHasPostedProposal(JSON.stringify([JSON.stringify({ Created: {} })]))).toBe(false);
    expect(sessionHasPostedProposal(null)).toBe(false);
    expect(sessionHasPostedProposal(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendReceiveStatus — internal reservation fields must not leak via the API
// ---------------------------------------------------------------------------

describe('appendReceiveStatus — reservation fields are internal', () => {
  it('omits reservedInputTxid/reservedInputVout (and session) from API responses', () => {
    const result = appendReceiveStatus(makeReceive({
      reservedInputTxid: 'a'.repeat(64),
      reservedInputVout: 1,
      session: '[]',
    }));
    expect(result).not.toHaveProperty('reservedInputTxid');
    expect(result).not.toHaveProperty('reservedInputVout');
    expect(result).not.toHaveProperty('session');
  });
});

// ---------------------------------------------------------------------------
// createSender — locked inputs recorded so restoreSendSessions can release
// them precisely later (no matching release existed at all previously)
// ---------------------------------------------------------------------------

describe('createSender — records exactly which outpoints lockUnspents:true locked', () => {

  const FUNDED_PSBT = 'cHNidP8BAH0...funded';
  const LOCKED_VIN = [
    { txid: 'a'.repeat(64), vout: 0, scriptSig: { asm: '', hex: '' }, txinwitness: [], sequence: 0 },
    { txid: 'b'.repeat(64), vout: 2, scriptSig: { asm: '', hex: '' }, txinwitness: [], sequence: 0 },
  ];

  function rawTxWithVin(vin: typeof LOCKED_VIN) {
    return {
      txid: 'c'.repeat(64), hash: 'c'.repeat(64), version: 2, size: 200, vsize: 200,
      weight: 800, locktime: 0, vin, vout: [],
    };
  }

  function setupHappyPath() {
    cnClient.getFeeRate.mockResolvedValue({ result: { feerate: 5 }, error: null });
    cnClient.getblockchaininfo.mockResolvedValue({ result: { blocks: 100 }, error: null });
    cnClient.createFundedPsbt.mockResolvedValue({ result: { psbt: FUNDED_PSBT, fee: 0.00001, changepos: 1 }, error: null });
    cnClient.decodePsbt.mockResolvedValue({ result: { inputs: [], outputs: [], tx: rawTxWithVin(LOCKED_VIN) }, error: null });
    cnClient.processPsbt.mockResolvedValue({ result: { psbt: 'signed', complete: true }, error: null });
  }

  beforeEach(() => jest.clearAllMocks());

  it('records the funded psbt\'s exact input outpoints as lockedInputs before signing', async () => {
    setupHappyPath();

    await createSender({ id: 7, pjUri: {} as never, amount: 100_000n, address: 'bcrt1qtest' });

    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { lockedInputs: [{ txid: 'a'.repeat(64), vout: 0 }, { txid: 'b'.repeat(64), vout: 2 }] },
    });
  });

  it('records lockedInputs before processPsbt runs (locked coins are known the moment createFundedPsbt returns)', async () => {
    setupHappyPath();
    const callOrder: string[] = [];
    db.send.update.mockImplementation(async () => { callOrder.push('db.send.update'); return {}; });
    cnClient.processPsbt.mockImplementation(async () => {
      callOrder.push('processPsbt');
      return { result: { psbt: 'signed', complete: true }, error: null };
    });

    await createSender({ id: 7, pjUri: {} as never, amount: 100_000n, address: 'bcrt1qtest' });

    expect(callOrder).toEqual(['db.send.update', 'processPsbt']);
  });

  it('throws and never records lockedInputs when createFundedPsbt itself fails (nothing was locked)', async () => {
    cnClient.getFeeRate.mockResolvedValue({ result: { feerate: 5 }, error: null });
    cnClient.getblockchaininfo.mockResolvedValue({ result: { blocks: 100 }, error: null });
    cnClient.createFundedPsbt.mockResolvedValue({ result: null, error: { code: -4, message: 'Insufficient funds' } });

    await expect(createSender({ id: 7, pjUri: {} as never, amount: 100_000n, address: 'bcrt1qtest' }))
      .rejects.toThrow('Failed to create funded psbt');
    expect(db.send.update).not.toHaveBeenCalled();
  });

  it('throws without recording lockedInputs when decoding the just-funded psbt fails', async () => {
    cnClient.getFeeRate.mockResolvedValue({ result: { feerate: 5 }, error: null });
    cnClient.getblockchaininfo.mockResolvedValue({ result: { blocks: 100 }, error: null });
    cnClient.createFundedPsbt.mockResolvedValue({ result: { psbt: FUNDED_PSBT, fee: 0.00001, changepos: 1 }, error: null });
    cnClient.decodePsbt.mockResolvedValue({ result: null, error: { code: -1, message: 'decode failed' } });

    await expect(createSender({ id: 7, pjUri: {} as never, amount: 100_000n, address: 'bcrt1qtest' }))
      .rejects.toThrow('Failed to decode funded psbt');
    expect(db.send.update).not.toHaveBeenCalled();
    expect(cnClient.processPsbt).not.toHaveBeenCalled();
  });
});
