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
    },
    send: {
      findFirst: jest.fn(),
      update: jest.fn(),
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

const RECEIVE_ADDRESS  = 'bc1qreceiveaddresspaidbysenderrr';
const GUESSED_TXID      = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const REAL_TXID          = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const RESERVED_TXID     = 'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333';
const RESERVED_VOUT     = 1;
const CALLBACK_URL       = 'https://example.com/callback';

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
});

describe('handleAddressCallback — receive, txid mismatch classification', () => {

  it('takes the normal update path without checking listUnspent when the txid already matches', async () => {
    const row = makeReceiveRow({ txid: REAL_TXID, reservedInputTxid: RESERVED_TXID, reservedInputVout: RESERVED_VOUT });
    db.receive.findFirst.mockResolvedValue(row);
    db.receive.update.mockResolvedValue({ ...row });

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive');

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

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive');

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

    await handleAddressCallback(webhookData({ txid: REAL_TXID, sent_amount: 0.00012345 }), 'receive');

    expect(cnClient.listUnspent).toHaveBeenCalledWith({ wallet: config.RECEIVE_WALLET });
    expect(db.receive.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: {
        amount: Utils.btcToSats(0.00012345),
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

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'receive');

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

    await handleAddressCallback(webhookData({ txid: REAL_TXID, sent_amount: 0.001 }), 'receive');

    const data = db.receive.update.mock.calls[0][0].data;
    expect(data).toEqual({
      amount: Utils.btcToSats(0.001),
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

    await handleAddressCallback(webhookData({ txid: REAL_TXID }), 'send');

    expect(cnClient.listUnspent).not.toHaveBeenCalled();
    expect(db.send.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ txid: REAL_TXID }),
    });
  });
});
