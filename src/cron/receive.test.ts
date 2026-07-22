import { broadcastFallback, sumReceiverInputs, checkNoInputsSeen, reserveCommittedInput, releaseReservedInput, availableInputs } from './receive';
import { SeenInputConflictError } from '../lib/seenInputs';
import { ReceiverPersister } from '../lib/persister';
import { Receive } from '@prisma/client';
import { Config } from '../config';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('payjoin', () => ({
  payjoin: {
    // pass-through record factories so availableInputs can build candidates
    TxIn: { create: jest.fn((x: unknown) => x) },
    OutPoint: { create: jest.fn((x: unknown) => x) },
    TxOut: { create: jest.fn((x: unknown) => x) },
    PsbtInput: { create: jest.fn((x: unknown) => x) },
    InputPair: jest.fn(),
  },
}));

jest.mock('../lib/globals', () => ({
  cnClient: {
    decodeRawTransaction: jest.fn(),
    sendRawTransaction: jest.fn(),
    lockUnspent: jest.fn(),
    listUnspent: jest.fn(),
    getTransaction: jest.fn(),
  },
  syncCnClient: {},
  lock: { acquire: jest.fn((_keys: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../lib/db', () => ({
  db: {
    receive: {
      update: jest.fn().mockResolvedValue({ id: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock('../lib/seenInputs', () => ({
  ...jest.requireActual('../lib/seenInputs'),
  claimSeenInputsForSession: jest.fn(),
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

const mockConfig: Pick<Config, 'RECEIVE_WALLET' | 'RESERVATION_RELEASE_GRACE'> = {
  RECEIVE_WALLET: '01',
  RESERVATION_RELEASE_GRACE: 86400,
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
    senderInAmount: null,
    senderOutAmount: null,
    txInputs: null,
    txOutputs: null,
    txid: null,
    fee: null,
    receiverFee: null,
    fallbackTxHex: FALLBACK_TX_HEX,
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
// checkNoInputsSeen — two-phase anti-probing adapter
// ---------------------------------------------------------------------------

describe('checkNoInputsSeen — durable claim before state persistence', () => {

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { claimSeenInputsForSession } = require('../lib/seenInputs');

  const BIP21_A = 'bitcoin:bc1qaaa?amount=0.001&pj=https://example.com';
  const SESSION_ID = 42;
  const persister = { events: [] } as unknown as ReceiverPersister;

  // Fake MaybeInputsSeen receiver: each checkNoInputsSeenBefore call runs the
  // callback over `outpoints` and returns a transition whose save() throws iff
  // any outpoint was reported seen — mirroring the FFI, where the rejection
  // transition's save() persists the error event and throws.
  function makeFakeReceiver(outpoints: Array<{ txid: string; vout: bigint }>) {
    const runs: Array<{ decisions: boolean[]; save: jest.Mock }> = [];
    const receiver = {
      checkNoInputsSeenBefore: ({ callback }: { callback: (o: { txid: string; vout: bigint }) => boolean }) => {
        const decisions = outpoints.map((o) => callback(o));
        const save = jest.fn(() => {
          if (decisions.some(Boolean)) throw new Error('ReceiverPersistedError.Storage');
          return 'NEXT_STATE';
        });
        runs.push({ decisions, save });
        return { save };
      },
    };
    return { receiver, runs };
  }

  const OUTPOINTS = [
    { txid: 'deadbeef', vout: 0n },
    { txid: 'cafebabe', vout: 1n },
  ];

  it('collects outpoints, claims them, then saves the tentative transition', async () => {
    claimSeenInputsForSession.mockResolvedValue(undefined);
    const { receiver, runs } = makeFakeReceiver(OUTPOINTS);

    const next = await checkNoInputsSeen(receiver as never, BIP21_A, persister, SESSION_ID);

    expect(next).toBe('NEXT_STATE');
    // bigint vouts converted to numbers for the DB claim
    expect(claimSeenInputsForSession).toHaveBeenCalledWith(BIP21_A, [
      { txid: 'deadbeef', vout: 0 },
      { txid: 'cafebabe', vout: 1 },
    ]);
    expect(runs).toHaveLength(1);
    // phase 1 is collect-only: every outpoint tentatively reported unseen
    expect(runs[0].decisions).toEqual([false, false]);
    expect(runs[0].save).toHaveBeenCalledTimes(1);
    expect(runs[0].save).toHaveBeenCalledWith(persister);
  });

  it('does not save the transition until the claim has committed', async () => {
    const { receiver, runs } = makeFakeReceiver(OUTPOINTS);
    claimSeenInputsForSession.mockImplementation(async () => {
      // At claim time the tentative transition must not have been persisted.
      expect(runs[0].save).not.toHaveBeenCalled();
    });

    await checkNoInputsSeen(receiver as never, BIP21_A, persister, SESSION_ID);

    expect(runs[0].save).toHaveBeenCalledTimes(1);
  });

  it('rejects the proposal via the PDK path on a cross-session conflict (probing attack)', async () => {
    // Another session already claimed deadbeef:0 — the classic probing replay.
    claimSeenInputsForSession.mockRejectedValue(new SeenInputConflictError(new Set(['deadbeef:0'])));
    const { receiver, runs } = makeFakeReceiver(OUTPOINTS);

    // The rejection transition's save() throw must propagate so the caller's
    // catch-all stamps failedTs → HasReplyableError → fallback broadcast.
    await expect(checkNoInputsSeen(receiver as never, BIP21_A, persister, SESSION_ID))
      .rejects.toThrow('ReceiverPersistedError.Storage');

    expect(runs).toHaveLength(2);
    // The tentative (unseen) transition was never persisted.
    expect(runs[0].save).not.toHaveBeenCalled();
    // The rerun reported exactly the conflicting outpoint as seen.
    expect(runs[1].decisions).toEqual([true, false]);
    expect(runs[1].save).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a transient DB error: nothing saved, session retried next cycle', async () => {
    claimSeenInputsForSession.mockRejectedValue(new Error('connection refused'));
    const { receiver, runs } = makeFakeReceiver(OUTPOINTS);

    const next = await checkNoInputsSeen(receiver as never, BIP21_A, persister, SESSION_ID);

    expect(next).toBeNull();
    expect(runs).toHaveLength(1);
    // No state transition persisted — no receiver input can be selected or
    // signed; the session replays MaybeInputsSeen on the next cron cycle.
    expect(runs[0].save).not.toHaveBeenCalled();
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

  it('abandons retries when inputs are already spent, preserving the original failure reason', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -25, message: 'bad-txns-inputs-missingorspent' },
    });

    await broadcastFallback(
      makeReceiveSess({ failedReason: 'OriginalPsbtRejected: The receiver rejected the original PSBT.' }),
      mockConfig as Config,
    );

    const updateArgs = db.receive.update.mock.calls[0][0];
    // dropped from the retry queue via fallbackAbandonedTs, keeping fallbackTxHex for history ...
    expect(updateArgs.data.fallbackAbandonedTs).toBeInstanceOf(Date);
    expect(updateArgs.data).not.toHaveProperty('fallbackTxHex');
    expect(updateArgs.data.failedReason).toBe(
      'OriginalPsbtRejected: The receiver rejected the original PSBT.; fallback abandoned: inputs already spent',
    );
    // ... without ever claiming payment — only the address watch may do that
    expect(updateArgs.data).not.toHaveProperty('txid');
    expect(updateArgs.data).not.toHaveProperty('amount');
    expect(updateArgs.data).not.toHaveProperty('fallbackTs');
  });

  it('abandons retries when the tx is already in chain, without claiming payment', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -27, message: 'Transaction already in block chain' },
    });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.fallbackAbandonedTs).toBeInstanceOf(Date);
    expect(updateArgs.data).not.toHaveProperty('fallbackTxHex');
    expect(updateArgs.data.failedReason).toContain('tx already broadcast');
    expect(updateArgs.data).not.toHaveProperty('txid');
    expect(updateArgs.data).not.toHaveProperty('amount');
    expect(updateArgs.data).not.toHaveProperty('fallbackTs');
  });

  it('keeps retrying on transient broadcast errors (no record change)', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));
    cnClient.sendRawTransaction.mockResolvedValue({
      result: null,
      error: { code: -26, message: 'txn-mempool-conflict' },
    });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('does not update db when sendRawTransaction fails', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));
    cnClient.sendRawTransaction.mockResolvedValue({ result: null, error: { code: -25, message: 'bad tx' } });

    await broadcastFallback(makeReceiveSess(), mockConfig as Config);

    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('checks the node for the posted proposal before broadcasting', async () => {
    const PROPOSAL_TXID = 'feed5678feed5678feed5678feed5678feed5678feed5678feed5678feed5678';
    // definite not-found — the only lookup outcome that may broadcast
    cnClient.getTransaction.mockResolvedValue({ result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } });
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));

    await broadcastFallback(makeReceiveSess({ txid: PROPOSAL_TXID }), mockConfig as Config);

    expect(cnClient.getTransaction).toHaveBeenCalledWith(PROPOSAL_TXID);
    expect(cnClient.sendRawTransaction).toHaveBeenCalled();
    expect(db.receive.update.mock.calls[0][0].data.txid).toBe(FALLBACK_TXID);
  });

  it('skips the broadcast and stamps firstSeenTs when the payjoin tx is known to the node', async () => {
    const PROPOSAL_TXID = 'feed5678feed5678feed5678feed5678feed5678feed5678feed5678feed5678';
    cnClient.getTransaction.mockResolvedValue({ result: { txid: PROPOSAL_TXID, confirmations: 0 } });

    await broadcastFallback(makeReceiveSess({ txid: PROPOSAL_TXID }), mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    const updateArgs = db.receive.update.mock.calls[0][0];
    expect(updateArgs.data.firstSeenTs).toBeInstanceOf(Date);
    // observation is recorded, but payment accounting stays with the address watch
    expect(updateArgs.data).not.toHaveProperty('fallbackTs');
    expect(updateArgs.data).not.toHaveProperty('amount');
  });

  it('defers the broadcast when the node lookup fails (unknown outcome, not "not found")', async () => {
    const PROPOSAL_TXID = 'feed5678feed5678feed5678feed5678feed5678feed5678feed5678feed5678';
    // transport/gatekeeper failure surfaces as a generic InternalError, not -5
    cnClient.getTransaction.mockResolvedValue({ result: null, error: { code: -32603, message: 'connect ECONNREFUSED' } });

    await broadcastFallback(makeReceiveSess({ txid: PROPOSAL_TXID }), mockConfig as Config);

    expect(cnClient.sendRawTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('does not consult the node when no proposal was ever posted (txid null)', async () => {
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx(ORIGINAL_ADDRESS));

    await broadcastFallback(makeReceiveSess({ txid: null }), mockConfig as Config);

    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(cnClient.sendRawTransaction).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// reserveCommittedInput — DB claim + checked persistent wallet lock (issue #8)
// ---------------------------------------------------------------------------

describe('reserveCommittedInput', () => {

  const RESERVED_TXID = 'a'.repeat(64);
  const COMMIT_EVENT = JSON.stringify({
    CommittedInputs: [{
      txin: { previous_output: `${RESERVED_TXID}:1`, script_sig: '', sequence: 0, witness: [] },
      psbtin: { witness_utxo: { value: 100000, script_pubkey: 'bb' } },
      expected_weight: 272,
    }],
  });

  it('claims the committed outpoint on the row and takes a checked persistent wallet lock', async () => {
    const claimed = makeReceiveSess({ reservedInputTxid: RESERVED_TXID, reservedInputVout: 1 });
    db.receive.update.mockResolvedValue(claimed);
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true } });

    const out = await reserveCommittedInput(makeReceiveSess(), [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBe(claimed);
    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { reservedInputTxid: RESERVED_TXID, reservedInputVout: 1 },
    });
    expect(cnClient.lockUnspent).toHaveBeenCalledWith({
      utxos: [{ txid: RESERVED_TXID, vout: 1 }],
      persistent: true,
      wallet: '01',
    });
    // no failure stamped
    expect(db.receive.updateMany).not.toHaveBeenCalled();
  });

  it('aborts before signing when the wallet lock fails, without burning the session', async () => {
    db.receive.update.mockResolvedValue(makeReceiveSess({ reservedInputTxid: RESERVED_TXID, reservedInputVout: 1 }));
    cnClient.lockUnspent.mockResolvedValue({ result: null, error: { code: -1, message: 'proxy unreachable' } });

    const out = await reserveCommittedInput(makeReceiveSess(), [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBeNull();
    // transient failure — no failedTs, session retries next cycle
    expect(db.receive.updateMany).not.toHaveBeenCalled();
  });

  it('aborts when the lock RPC reports success: false', async () => {
    db.receive.update.mockResolvedValue(makeReceiveSess({ reservedInputTxid: RESERVED_TXID, reservedInputVout: 1 }));
    cnClient.lockUnspent.mockResolvedValue({ result: { success: false }, error: null });

    const out = await reserveCommittedInput(makeReceiveSess(), [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBeNull();
  });

  it('treats "already locked" as ours on an idempotent re-pass holding the DB claim', async () => {
    const sess = makeReceiveSess({ reservedInputTxid: RESERVED_TXID, reservedInputVout: 1 });
    cnClient.lockUnspent.mockResolvedValue({
      result: null,
      error: { code: -8, message: 'Invalid parameter, output already locked' },
    });

    const out = await reserveCommittedInput(sess, [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBe(sess);
    // claim already recorded — no second DB write
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('fails the session when another session owns the outpoint (unique-constraint conflict)', async () => {
    db.receive.update.mockRejectedValue(Object.assign(new Error('unique constraint'), { code: 'P2002' }));

    const out = await reserveCommittedInput(makeReceiveSess(), [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBeNull();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.updateMany).toHaveBeenCalledWith({
      where: { id: 1, failedTs: null },
      data: expect.objectContaining({
        failedTs: expect.any(Date),
        failedReason: expect.stringContaining('input_reservation_conflict'),
      }),
    });
  });

  it('fails the session when the committed input cannot be identified from the log', async () => {
    const out = await reserveCommittedInput(
      makeReceiveSess(),
      [JSON.stringify({ Created: {} })],
      mockConfig as Config,
    );

    expect(out).toBeNull();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.updateMany).toHaveBeenCalledWith({
      where: { id: 1, failedTs: null },
      data: expect.objectContaining({
        failedReason: expect.stringContaining('cannot identify committed receiver input'),
      }),
    });
  });

  it('retries next cycle (no failedTs) on a transient DB error recording the claim', async () => {
    db.receive.update.mockRejectedValue(new Error('connection refused'));

    const out = await reserveCommittedInput(makeReceiveSess(), [COMMIT_EVENT], mockConfig as Config);

    expect(out).toBeNull();
    expect(db.receive.updateMany).not.toHaveBeenCalled();
    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// releaseReservedInput — reservation lifecycle release rules (issue #8)
// ---------------------------------------------------------------------------

describe('releaseReservedInput', () => {

  const RESERVED_TXID = 'b'.repeat(64);
  const POSTED_SESSION = JSON.stringify([JSON.stringify({ PostedPayjoinProposal: [] })]);
  const PROPOSAL_TXID = 'c'.repeat(64);

  function reservedSess(overrides: Partial<Receive> = {}): Receive {
    return makeReceiveSess({
      reservedInputTxid: RESERVED_TXID,
      reservedInputVout: 1,
      ...overrides,
    });
  }

  const UNLOCK_CALL = {
    unlock: true,
    persistent: true,
    utxos: [{ txid: RESERVED_TXID, vout: 1 }],
    wallet: '01',
  };
  const CLEAR_CALL = {
    where: { id: 1 },
    data: { reservedInputTxid: null, reservedInputVout: null },
  };

  it('unlocks and clears a cancelled session whose proposal was never posted', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({ cancelledTs: new Date() }));
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true } });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith(UNLOCK_CALL);
    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('keeps a posted, unconfirmed session reserved (mempool observation is not finality)', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: PROPOSAL_TXID,
      expiryTs: new Date(Date.now() - 1000),
      confirmedTs: null,
    }));

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('clears a confirmed payjoin without any unlock RPC — the input is spent', async () => {
    // Core already removed the lock when the payjoin tx arrived; an unlock
    // call would just fail with "expected unspent output"
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: PROPOSAL_TXID,
      confirmedTs: new Date(),
    }));

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('unlocks for real when the conflicting original confirms instead of the payjoin', async () => {
    // sender broadcast its original (recorded via the non-payjoin path) — the
    // proposal is dead and our input is unspent, so the wallet lock must go
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: FALLBACK_TXID,
      nonPayjoinTs: new Date(),
      confirmedTs: new Date(),
    }));
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx());
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true } });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith(UNLOCK_CALL);
    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('treats an externally-spent outpoint ("expected unspent output") as released', async () => {
    // never-posted terminal session whose coin was spent by something else —
    // the exact Core 24 message observed when unlocking a spent coin
    db.receive.findUnique.mockResolvedValue(reservedSess({ cancelledTs: new Date() }));
    cnClient.lockUnspent.mockResolvedValue({
      result: null,
      error: { code: -32603, message: 'Invalid parameter, expected unspent output' },
    });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('retains the reservation and retries when the unlock genuinely fails', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({ cancelledTs: new Date() }));
    cnClient.lockUnspent.mockResolvedValue({ result: null, error: { code: -1, message: 'proxy unreachable' } });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('keeps the reservation when the confirmed tx is unrelated to the posted proposal', async () => {
    // an unrelated payment to the watched address does not invalidate the proposal
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: 'f'.repeat(64),
      nonPayjoinTs: new Date(),
      confirmedTs: new Date(),
    }));
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx());

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('no-ops when the row holds no reservation', async () => {
    db.receive.findUnique.mockResolvedValue(makeReceiveSess());

    await releaseReservedInput(makeReceiveSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Bounded hold: RESERVATION_RELEASE_GRACE past expiry force-releases
  // -------------------------------------------------------------------------

  const GRACE_MS = 86400 * 1000;

  it('force-releases a posted, never-confirmed session once grace past expiry has elapsed', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: PROPOSAL_TXID,
      expiryTs: new Date(Date.now() - GRACE_MS - 60_000),
      confirmedTs: null,
    }));
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true } });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith(UNLOCK_CALL);
    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('still keeps a posted, unconfirmed session while within the grace window', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: PROPOSAL_TXID,
      expiryTs: new Date(Date.now() - GRACE_MS + 60_000),
      confirmedTs: null,
    }));

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('force-releases a wedged "neither payjoin nor original" session after grace', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: 'f'.repeat(64), // unrelated tx overwrote the row txid
      nonPayjoinTs: new Date(),
      confirmedTs: new Date(),
      expiryTs: new Date(Date.now() - GRACE_MS - 60_000),
    }));
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx());
    cnClient.lockUnspent.mockResolvedValue({ result: { success: true } });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).toHaveBeenCalledWith(UNLOCK_CALL);
    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('tolerates a spent reserved input when force-releasing (payjoin confirmed but row wedged)', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: 'f'.repeat(64),
      nonPayjoinTs: new Date(),
      confirmedTs: new Date(),
      expiryTs: new Date(Date.now() - GRACE_MS - 60_000),
    }));
    cnClient.decodeRawTransaction.mockResolvedValue(mockDecodedFallbackTx());
    cnClient.lockUnspent.mockResolvedValue({
      result: null,
      error: { code: -32603, message: 'Invalid parameter, expected unspent output' },
    });

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(db.receive.update).toHaveBeenCalledWith(CLEAR_CALL);
  });

  it('never force-releases a posted session with no expiryTs', async () => {
    db.receive.findUnique.mockResolvedValue(reservedSess({
      session: POSTED_SESSION,
      txid: PROPOSAL_TXID,
      expiryTs: null,
      confirmedTs: null,
    }));

    await releaseReservedInput(reservedSess(), mockConfig as Config);

    expect(cnClient.lockUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// availableInputs — DB-reserved outpoints are never offered as candidates
// ---------------------------------------------------------------------------

describe('availableInputs — reserved-outpoint filter', () => {

  const TXID_A = 'a'.repeat(64);
  const TXID_B = 'b'.repeat(64);

  const utxo = (txid: string, vout: number, amount = 0.001) => ({
    txid, vout, amount, confirmations: 3, scriptPubKey: 'aabb',
  });

  beforeEach(() => {
    cnClient.getTransaction.mockResolvedValue({ result: { tx: {} }, error: null });
  });

  it('excludes outpoints reserved by other sessions', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0), utxo(TXID_B, 7)] }, error: null });
    db.receive.findMany.mockResolvedValue([{ reservedInputTxid: TXID_B, reservedInputVout: 7 }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(1);
    expect(inputs[0].txid).toBe(TXID_A);
    // the reserved candidate is dropped before any per-utxo RPC work
    expect(cnClient.getTransaction).toHaveBeenCalledTimes(1);
    expect(cnClient.getTransaction).toHaveBeenCalledWith(TXID_A);
  });

  it('only queries currently-held reservations, not historical ones', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0)] }, error: null });
    db.receive.findMany.mockResolvedValue([]);

    await availableInputs(mockConfig as Config, 100_000n);

    expect(db.receive.findMany).toHaveBeenCalledWith({
      where: { reservedInputTxid: { not: null } },
      select: { reservedInputTxid: true, reservedInputVout: true },
    });
  });

  it('returns no candidates when every unspent coin is reserved', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0)] }, error: null });
    db.receive.findMany.mockResolvedValue([{ reservedInputTxid: TXID_A, reservedInputVout: 0 }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(0);
    expect(cnClient.getTransaction).not.toHaveBeenCalled();
  });

  it('does not exclude a same-txid different-vout sibling of a reserved coin', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0), utxo(TXID_A, 1)] }, error: null });
    db.receive.findMany.mockResolvedValue([{ reservedInputTxid: TXID_A, reservedInputVout: 0 }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(1);
    expect(inputs[0].vout).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// availableInputs — anti-snowball ancestry filter (issue #9)
// ---------------------------------------------------------------------------

describe('availableInputs — prior-Payjoin-proposal ancestry filter', () => {

  const TXID_A = 'a'.repeat(64);
  const TXID_B = 'b'.repeat(64);

  const utxo = (txid: string, vout: number, amount = 0.001) => ({
    txid, vout, amount, confirmations: 3, scriptPubKey: 'aabb',
  });

  beforeEach(() => {
    cnClient.getTransaction.mockResolvedValue({ result: { tx: {} }, error: null });
  });

  it('excludes a candidate whose parent txid is a prior generated proposal', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0), utxo(TXID_B, 0)] }, error: null });
    // first call: no reservations held; second call: TXID_A is a prior Payjoin proposal
    db.receive.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ txid: TXID_A }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(1);
    expect(inputs[0].txid).toBe(TXID_B);
    expect(db.receive.findMany).toHaveBeenLastCalledWith({
      where: { txid: { in: [TXID_A, TXID_B] }, fallbackTs: null, nonPayjoinTs: null },
      select: { txid: true },
    });
  });

  it('scopes the ancestry lookup to exclude fallback and non-Payjoin rows, so their txid never taints a parent', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0)] }, error: null });
    db.receive.findMany
      .mockResolvedValueOnce([]) // no reservations
      .mockResolvedValueOnce([]); // a real DB applying the where-clause below excludes fallback/non-Payjoin rows

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(1);
    expect(inputs[0].txid).toBe(TXID_A);
    expect(db.receive.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fallbackTs: null, nonPayjoinTs: null }) })
    );
  });

  it('does not apply recursive ancestry taint to an intervening ordinary spend', async () => {
    // TXID_B is an ordinary wallet spend that consumed a prior Payjoin output; its own
    // change (this candidate) must remain eligible even though its grandparent was tainted.
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_B, 0)] }, error: null });
    db.receive.findMany
      .mockResolvedValueOnce([]) // no reservations
      .mockResolvedValueOnce([]); // TXID_B itself was never a generated proposal

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(1);
    expect(inputs[0].txid).toBe(TXID_B);
  });

  it('excludes every wallet-owned output sharing a tainted parent', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0), utxo(TXID_A, 1)] }, error: null });
    db.receive.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ txid: TXID_A }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(0);
  });

  it('returns no candidates when every eligible coin is tainted (falls through to no-input/fallback lifecycle)', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0)] }, error: null });
    db.receive.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ txid: TXID_A }]);

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(0);
    expect(cnClient.getTransaction).not.toHaveBeenCalled();
  });

  it('fails closed — a database error checking ancestry yields no candidates', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [utxo(TXID_A, 0)] }, error: null });
    db.receive.findMany
      .mockResolvedValueOnce([]) // reservation lookup succeeds
      .mockRejectedValueOnce(new Error('connection lost')); // ancestry lookup fails

    const inputs = await availableInputs(mockConfig as Config, 100_000n);

    expect(inputs).toHaveLength(0);
    expect(cnClient.getTransaction).not.toHaveBeenCalled();
  });

  it('skips the ancestry query entirely when there are no eligible candidates', async () => {
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [] }, error: null });

    await availableInputs(mockConfig as Config, 100_000n);

    expect(db.receive.findMany).toHaveBeenCalledTimes(1); // only the reservation lookup
  });
});
