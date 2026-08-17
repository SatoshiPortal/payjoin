import { handleAddressCallback } from './address';
import { Receive } from '@prisma/client';
import { config } from '../../config';
import Utils from '../../lib/Utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('payjoin', () => ({
  payjoin: {},
}));

jest.mock('../../lib/globals', () => ({
  cnClient: {
    getTransaction: jest.fn(),
    listUnspent: jest.fn(),
    unwatch: jest.fn(),
  },
  lock: { acquire: jest.fn((_key: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../../lib/db', () => ({
  db: {
    receive: {
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    send: {
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock('../../lib/Log2File', () => ({
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
const { cnClient } = require('../../lib/globals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db }       = require('../../lib/db');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logger       = require('../../lib/Log2File').default;

const RECEIVE_ADDRESS  = 'bc1qreceiveaddresspaidbysenderrr';
const GUESSED_TXID      = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const REAL_TXID          = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const RESERVED_TXID     = 'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333';
const RESERVED_VOUT     = 1;
const CALLBACK_URL       = 'https://example.com/callback';
const CALLBACK_TOKEN     = 'callback-token';

function makeReceiveRow(overrides: Partial<Receive> = {}): Receive {
  return {
    id: 1,
    bip21: `bitcoin:${RECEIVE_ADDRESS}?amount=0.001&pj=https://example.com`,
    address: RECEIVE_ADDRESS,
    amount: 100_000n,
    receiverInAmount: 150_000n,
    receiverOutAmount: 250_000n,
    senderInAmount: 122_563n,
    senderOutAmount: 20_477n,
    txInputs: null,
    txOutputs: null,
    txid: GUESSED_TXID,
    fee: 2_381n,
    receiverFee: 0n,
    fallbackTxHex: null,
    fallbackAbandonedTs: null,
    reservedInputTxid: null,
    reservedInputVout: null,
    callbackUrl: CALLBACK_URL,
    callbackToken: CALLBACK_TOKEN,
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

function webhookData(overrides: Record<string, unknown> = {}) {
  return {
    address: RECEIVE_ADDRESS,
    txid: REAL_TXID,
    sent_amount: 0.0024943,
    fees: 0.00002381,
    confirmations: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Utils, 'post').mockResolvedValue(true);
  cnClient.getTransaction.mockImplementation(async (txid: string) => ({
    result: {
      txid,
      confirmations: 0,
      vout: [{ value: 0.0024943, scriptPubKey: { address: RECEIVE_ADDRESS } }],
    },
  }));
});

describe('handleAddressCallback — receive, txid mismatch classification', () => {

  it('rejects an incorrect token before looking up the transaction or changing state', async () => {
    db.receive.findFirst.mockResolvedValue(null);
    db.receive.count.mockResolvedValue(1);

    await handleAddressCallback(webhookData(), 'receive', 'wrong-token');

    expect(db.receive.findFirst).toHaveBeenCalledWith({
      where: { address: RECEIVE_ADDRESS, confirmedTs: null, callbackToken: 'wrong-token' },
    });
    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
    expect(Utils.post).not.toHaveBeenCalled();
  });

  // A bad capability must stay separable from "nothing to apply this to", or the only
  // signal that someone is probing the callback route drowns in routine noise.
  it('warns about an invalid token when a pending session exists for the address', async () => {
    db.receive.findFirst.mockResolvedValue(null);
    db.receive.count.mockResolvedValue(1);

    await handleAddressCallback(webhookData(), 'receive', 'wrong-token');

    expect(db.receive.count).toHaveBeenCalledWith({
      where: { address: RECEIVE_ADDRESS, confirmedTs: null },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(Function),
      `invalid callback token for receive address: ${RECEIVE_ADDRESS}`,
    );
  });

  it('does not warn when there is simply no pending session for the address', async () => {
    db.receive.findFirst.mockResolvedValue(null);
    db.receive.count.mockResolvedValue(0);

    await handleAddressCallback(webhookData(), 'receive', CALLBACK_TOKEN);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(Function),
      `no pending payjoin receive for address: ${RECEIVE_ADDRESS}`,
    );
  });

  // Prisma drops an `undefined` filter instead of matching null, so an address-less body
  // would otherwise select an arbitrary pending session.
  it('rejects a callback whose body carries no address, without querying at all', async () => {
    await handleAddressCallback({ txid: REAL_TXID, confirmations: 1 }, 'receive', CALLBACK_TOKEN);

    expect(db.receive.findFirst).not.toHaveBeenCalled();
    expect(db.receive.count).not.toHaveBeenCalled();
    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
    expect(Utils.post).not.toHaveBeenCalled();
  });

  it('accepts a tokenless pre-migration session only while it is unexpired', async () => {
    const row = makeReceiveRow({ callbackToken: null, expiryTs: new Date(Date.now() + 60_000) });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, txid: REAL_TXID });

    await handleAddressCallback(webhookData(), 'receive');

    expect(db.receive.findFirst).toHaveBeenCalledWith({
      where: { address: RECEIVE_ADDRESS, confirmedTs: null, callbackToken: null },
    });
    expect(cnClient.getTransaction).toHaveBeenCalledWith(REAL_TXID);
    expect(db.receive.update).toHaveBeenCalled();
  });

  it('rejects an expired tokenless pre-migration session', async () => {
    db.receive.findFirst.mockResolvedValue(
      makeReceiveRow({ callbackToken: null, expiryTs: new Date(Date.now() - 1) }),
    );

    await handleAddressCallback(webhookData(), 'receive');

    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('accepts an expired tokenless receive session awaiting its fallback outcome', async () => {
    const row = makeReceiveRow({
      callbackToken: null,
      expiryTs: new Date(Date.now() - 1),
      fallbackTxHex: 'deadbeef',
      txid: REAL_TXID,
    });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive');

    expect(cnClient.getTransaction).toHaveBeenCalledWith(REAL_TXID);
    expect(db.receive.update).toHaveBeenCalled();
  });

  it('does not reopen an expired cancelled tokenless fallback session', async () => {
    db.receive.findFirst.mockResolvedValue(makeReceiveRow({
      callbackToken: null,
      expiryTs: new Date(Date.now() - 1),
      fallbackTxHex: 'deadbeef',
      cancelledTs: new Date(),
    }));

    await handleAddressCallback(webhookData(), 'receive');

    expect(cnClient.getTransaction).not.toHaveBeenCalled();
    expect(db.receive.update).not.toHaveBeenCalled();
  });

  it('rejects a transaction that pays the session address nothing (the forgery case)', async () => {
    db.receive.findFirst.mockResolvedValue(makeReceiveRow());
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 6,
        vout: [{ value: 5, scriptPubKey: { address: 'bc1qsomeoneelsesaddress' } }],
      },
    });

    await handleAddressCallback(webhookData({ confirmations: 6 }), 'receive', CALLBACK_TOKEN);

    expect(db.receive.update).not.toHaveBeenCalled();
    expect(Utils.post).not.toHaveBeenCalled();
  });

  // An underpayment is a real payment the operator accepts; dropping the callback
  // would leave money on-chain with no record and no notification downstream.
  it('records and reports an underpaying transaction using the Cyphernode-derived amount', async () => {
    const row = makeReceiveRow();  // invoiced 100_000 sats
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, amount: 50_000n, txid: REAL_TXID, nonPayjoinTs: new Date() });
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 0,
        vout: [{ value: 0.0005, scriptPubKey: { address: RECEIVE_ADDRESS } }],
      },
    });

    await handleAddressCallback(webhookData({ sent_amount: 0.0005 }), 'receive', CALLBACK_TOKEN);

    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ amount: 50_000n, txid: REAL_TXID, nonPayjoinTs: expect.any(Date) }),
    });
    expect(Utils.post).toHaveBeenCalled();
  });

  // Rejecting here would strand the session: callbacks are acked with 200 before
  // handling, so cyphernode never retries a dropped one.
  it('accepts a confirmation claim higher than Cyphernode reports but does not confirm', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row });
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 0,
        vout: [{ value: 0.002, scriptPubKey: { address: RECEIVE_ADDRESS } }],
      },
    });

    await handleAddressCallback(webhookData({ confirmations: 1 }), 'receive', CALLBACK_TOKEN);

    expect(db.receive.update).toHaveBeenCalled();
    expect(db.receive.update.mock.calls[0][0].data).not.toHaveProperty('confirmedTs');
  });

  it('confirms from the Cyphernode count even when the callback claims fewer confirmations', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, confirmedTs: new Date() });
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 3,
        vout: [{ value: 0.002, scriptPubKey: { address: RECEIVE_ADDRESS } }],
      },
    });

    await handleAddressCallback(webhookData({ confirmations: 0 }), 'receive', CALLBACK_TOKEN);

    expect(db.receive.update.mock.calls[0][0].data).toHaveProperty('confirmedTs');
  });

  it('never sends the callback token to the webhook endpoint', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive', CALLBACK_TOKEN);

    expect(Utils.post).toHaveBeenCalled();
    const postData = (Utils.post as jest.Mock).mock.calls[0][1];
    expect(postData).not.toHaveProperty('callbackToken');
    expect(JSON.stringify(postData)).not.toContain(CALLBACK_TOKEN);
  });

  it('keeps the callback fee update for a verified zero-conf transaction', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, firstSeenTs: new Date() });

    await handleAddressCallback(webhookData({ fees: 0.00001234 }), 'receive', CALLBACK_TOKEN);

    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({
        fee: Utils.btcToSats(0.00001234),
        firstSeenTs: expect.any(Date),
      }),
    });
    expect(db.receive.update.mock.calls[0][0].data).not.toHaveProperty('confirmedTs');
    expect(Utils.post).toHaveBeenCalled();
  });

  it('takes the normal update path without checking listUnspent when the txid already matches', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID, reservedInputTxid: RESERVED_TXID, reservedInputVout: RESERVED_VOUT });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive', CALLBACK_TOKEN);

    expect(cnClient.listUnspent).not.toHaveBeenCalled();
    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ txid: REAL_TXID }),
    });
    // the normal path never touches amount/receiverInAmount/nonPayjoinTs
    const data = db.receive.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('amount');
    expect(data).not.toHaveProperty('receiverInAmount');
    expect(data).not.toHaveProperty('nonPayjoinTs');
  });

  it('classifies a mismatch as OUR payjoin when the reserved input has been spent (the P2SH-P2WPKH bug)', async () => {
    const row = makeReceiveRow({ txid: GUESSED_TXID, reservedInputTxid: RESERVED_TXID, reservedInputVout: RESERVED_VOUT });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, txid: REAL_TXID });
    // reserved outpoint no longer appears in listunspent -> it has been spent
    cnClient.listUnspent.mockResolvedValue({ result: { utxos: [] } });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive', CALLBACK_TOKEN);

    expect(cnClient.listUnspent).toHaveBeenCalledWith({ wallet: config.RECEIVE_WALLET });
    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ txid: REAL_TXID }),
    });
    const data = db.receive.update.mock.calls[0][0].data;
    // must NOT be misclassified as non-payjoin: amount/receiverIn/OutAmount stay untouched,
    // nonPayjoinTs never gets stamped
    expect(data).not.toHaveProperty('amount');
    expect(data).not.toHaveProperty('receiverInAmount');
    expect(data).not.toHaveProperty('receiverOutAmount');
    expect(data).not.toHaveProperty('nonPayjoinTs');
  });

  it('classifies a mismatch as a genuine non-payjoin transaction when the reserved input is still unspent', async () => {
    const row = makeReceiveRow({ txid: GUESSED_TXID, reservedInputTxid: RESERVED_TXID, reservedInputVout: RESERVED_VOUT });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, txid: REAL_TXID, nonPayjoinTs: new Date() });
    // our reserved coin is untouched -> whatever this transaction is, it isn't our payjoin
    cnClient.listUnspent.mockResolvedValue({
      result: { utxos: [{ txid: RESERVED_TXID, vout: RESERVED_VOUT, address: 'x', label: '', scriptPubKey: '', amount: 0.0015, confirmations: 1, spendable: true, solvable: true, safe: true }] },
    });

    await handleAddressCallback(webhookData({ txid: REAL_TXID, sent_amount: 0.00012345 }), 'receive', CALLBACK_TOKEN);

    expect(cnClient.listUnspent).toHaveBeenCalledWith({ wallet: config.RECEIVE_WALLET });
    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: {
        amount: Utils.btcToSats(0.0024943),
        receiverFee: 0n,
        receiverInAmount: 0n,
        receiverOutAmount: 0n,
        txid: REAL_TXID,
        nonPayjoinTs: expect.any(Date),
      },
    });
  });

  it('classifies a mismatch as a genuine non-payjoin transaction when the session never reserved a receiver input', async () => {
    // no receiver-input contribution at all -> can never be "our payjoin under a wrong txid"
    const row = makeReceiveRow({ txid: GUESSED_TXID, reservedInputTxid: null, reservedInputVout: null });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, txid: REAL_TXID, nonPayjoinTs: new Date() });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive', CALLBACK_TOKEN);

    // no receiver input was ever reserved, so there's nothing to check on-chain for
    expect(cnClient.listUnspent).not.toHaveBeenCalled();
    const data = db.receive.update.mock.calls[0][0].data;
    expect(data.nonPayjoinTs).toBeInstanceOf(Date);
    expect(data.receiverInAmount).toBe(0n);
    expect(data.receiverOutAmount).toBe(0n);
  });

  it('still takes the fallback-tx path when fallbackTs is set, unaffected by the reserved-input check', async () => {
    const row = makeReceiveRow({
      txid: GUESSED_TXID,
      fallbackTs: new Date(),
      reservedInputTxid: RESERVED_TXID,
      reservedInputVout: RESERVED_VOUT,
    });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row, txid: REAL_TXID });
    // a real fallback broadcast never spends the receiver's reserved contribution coin
    cnClient.listUnspent.mockResolvedValue({
      result: { utxos: [{ txid: RESERVED_TXID, vout: RESERVED_VOUT, address: 'x', label: '', scriptPubKey: '', amount: 0.0015, confirmations: 1, spendable: true, solvable: true, safe: true }] },
    });

    await handleAddressCallback(webhookData({ txid: REAL_TXID, sent_amount: 0.001 }), 'receive', CALLBACK_TOKEN);

    const data = db.receive.update.mock.calls[0][0].data;
    expect(data).toEqual({
      amount: Utils.btcToSats(0.0024943),
      receiverFee: 0n,
      receiverInAmount: 0n,
      receiverOutAmount: 0n,
    });
    expect(data).not.toHaveProperty('nonPayjoinTs');
  });

  it('never checks listUnspent for a "send" session (reserved-input check is receive-only)', async () => {
    const row = makeReceiveRow({ txid: GUESSED_TXID, reservedInputTxid: RESERVED_TXID, reservedInputVout: RESERVED_VOUT });
    db.send.findFirst.mockResolvedValue(row);
    db.send.update.mockResolvedValue({ ...row, txid: REAL_TXID });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'send', CALLBACK_TOKEN);

    expect(cnClient.listUnspent).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ txid: REAL_TXID }),
    });
  });

  it('selects the exact tokenized send when multiple pending sends share an address', async () => {
    const secondToken = 'second-callback-token';
    const row = makeReceiveRow({ id: 2, callbackToken: secondToken, txid: REAL_TXID });
    db.send.findFirst.mockResolvedValue(row);
    db.send.update.mockResolvedValue({ ...row });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'send', secondToken);

    expect(db.send.findFirst).toHaveBeenCalledWith({
      where: { address: RECEIVE_ADDRESS, confirmedTs: null, callbackToken: secondToken },
    });
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: expect.objectContaining({ txid: REAL_TXID }),
    });
  });

  it('rejects an underpaying send claimed against a txid we never broadcast (the forgery case)', async () => {
    const row = makeReceiveRow({ txid: GUESSED_TXID, amount: 100_000n });
    db.send.findFirst.mockResolvedValue(row);
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 0,
        vout: [{ value: 0.0005, scriptPubKey: { address: RECEIVE_ADDRESS } }],
      },
    });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'send', CALLBACK_TOKEN);

    expect(db.send.update).not.toHaveBeenCalled();
    expect(Utils.post).not.toHaveBeenCalled();
    expect(cnClient.unwatch).not.toHaveBeenCalled();
  });

  // A shortfall against the txid validateAndBroadcastPayjoinPsbt already recorded is not a
  // forged claim — it's our own signed, broadcast proposal, and (with no fee_contribution
  // offered) the receiver is allowed to shave its fee-rate top-up off its own payee output
  // rather than the sender's. That must still be recorded and reported, confirmations and all.
  it('records an underpaying send when it matches the txid we already broadcast ourselves', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID, amount: 100_000n });
    db.send.findFirst.mockResolvedValue(row);
    db.send.update.mockResolvedValue({ ...row, confirmedTs: new Date() });
    cnClient.getTransaction.mockResolvedValue({
      result: {
        txid: REAL_TXID,
        confirmations: 1,
        vout: [{ value: 0.0005, scriptPubKey: { address: RECEIVE_ADDRESS } }],
      },
    });

    await handleAddressCallback(webhookData({ txid: REAL_TXID, confirmations: 1 }), 'send', CALLBACK_TOKEN);

    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ txid: REAL_TXID, confirmedTs: expect.any(Date) }),
    });
    expect(cnClient.unwatch).toHaveBeenCalled();
  });
});
