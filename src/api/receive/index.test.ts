import { receive } from './index';
import { IReqReceive } from '../../types/api/receive';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// payjoin is an ESM package — mock it so Jest can parse the module graph.
jest.mock('payjoin', () => ({ payjoin: {} }));

// src/api/index.ts wires up the JSON-RPC server on import; only the registration
// helper is needed here.
jest.mock('..', () => ({ addJsonRpcMethod: jest.fn() }));

jest.mock('../../lib/validate', () => ({
  isValidAddress: jest.fn(),
  isOwnedAddress: jest.fn(),
  isValidAmount: jest.fn(),
}));

jest.mock('../../lib/payjoin', () => ({
  createReceiver: jest.fn(),
  appendReceiveStatus: jest.fn((row: unknown) => row),
}));

jest.mock('../../lib/db', () => ({
  db: { receive: { create: jest.fn(), update: jest.fn() } },
}));

jest.mock('../../lib/globals', () => ({
  cnClient: { getnewaddress: jest.fn(), watch: jest.fn() },
  lock: { acquire: jest.fn((_key: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../callback', () => ({
  addressCallbackUrl: jest.fn(() => 'http://payjoin:8000/receive/address/x'),
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
const { isValidAddress, isOwnedAddress, isValidAmount } = require('../../lib/validate');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createReceiver } = require('../../lib/payjoin');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('../../lib/db');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnClient } = require('../../lib/globals');

const CALLER_ADDRESS = 'bcrt1qu2xt7tsqastdgv2pnresamwm4t6je5lgtmfkvh';
const DERIVED_ADDRESS = 'bcrt1qs0llzk5lzreev7mrwldrqmw3rs340u9qmx9dc8';
const OWNERSHIP_MSG = 'Address is not owned by a configured wallet';

function params(overrides: Partial<IReqReceive> = {}): IReqReceive {
  return { amount: 100_000n, ...overrides };
}

/** Returns the JSONRPCErrorException thrown by receive(), or fails the test. */
async function captureError(p: IReqReceive): Promise<{ message: string; code: number }> {
  try {
    await receive(p);
  } catch (e) {
    return e as { message: string; code: number };
  }
  throw new Error('expected receive() to throw');
}

describe('receive address ownership gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    isValidAddress.mockResolvedValue(true);
    isValidAmount.mockReturnValue(true);
    isOwnedAddress.mockResolvedValue(true);

    cnClient.getnewaddress.mockResolvedValue({ result: { address: DERIVED_ADDRESS } });
    cnClient.watch.mockResolvedValue({});

    db.receive.create.mockResolvedValue({ id: 1 });
    db.receive.update.mockResolvedValue({ id: 1 });
    createReceiver.mockResolvedValue({ bip21: 'bitcoin:x?pj=y', ohttpRelay: 'https://relay' });
  });

  it('probes ownership of a caller-supplied address', async () => {
    await receive(params({ address: CALLER_ADDRESS }));

    expect(isOwnedAddress).toHaveBeenCalledWith(CALLER_ADDRESS);
    expect(db.receive.create).toHaveBeenCalled();
  });

  // Regression guard for the ordering in receive(): `callerSuppliedAddress` is
  // captured before the derive branch assigns params.address. If that capture
  // ever moves below the branch, every self-derived session starts probing —
  // which is wasted work, and it hides the gate behind a check that can never
  // fail. This test is the only thing that would catch it.
  it('does not probe ownership of a self-derived address', async () => {
    await receive(params());

    expect(cnClient.getnewaddress).toHaveBeenCalledWith({
      addressType: 'bech32',
      wallet: expect.any(String),
    });
    expect(isOwnedAddress).not.toHaveBeenCalled();
    expect(db.receive.create).toHaveBeenCalled();
  });

  it('rejects an unowned caller-supplied address with -32602 and the ownership message', async () => {
    isOwnedAddress.mockResolvedValue(false);

    const err = await captureError(params({ address: CALLER_ADDRESS }));

    // The exact message matters: the format check ahead of this one returns the
    // same code, so asserting only on -32602 would not exercise this gate.
    expect(err.message).toBe(OWNERSHIP_MSG);
    expect(err.code).toBe(-32602);
  });

  it('creates no session row and no address watch when ownership fails', async () => {
    isOwnedAddress.mockResolvedValue(false);

    await captureError(params({ address: CALLER_ADDRESS }));

    expect(db.receive.create).not.toHaveBeenCalled();
    expect(createReceiver).not.toHaveBeenCalled();
    expect(cnClient.watch).not.toHaveBeenCalled();
  });

  it('runs the format check before the ownership probe', async () => {
    isValidAddress.mockResolvedValue(false);

    const err = await captureError(params({ address: 'not-an-address' }));

    expect(err.message).toBe('Invalid address');
    expect(isOwnedAddress).not.toHaveBeenCalled();
  });

  it('runs the ownership probe before the amount check', async () => {
    isOwnedAddress.mockResolvedValue(false);
    isValidAmount.mockReturnValue(false);

    const err = await captureError(params({ address: CALLER_ADDRESS }));

    expect(err.message).toBe(OWNERSHIP_MSG);
  });
});
