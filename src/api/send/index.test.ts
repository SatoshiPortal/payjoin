import { send, validateBip21, registerSendApi } from './index';
import { addJsonRpcMethod } from '..';
import { parseBip21, createSender } from '../../lib/payjoin';
import { isValidAddress } from '../../lib/validate';

jest.mock('payjoin', () => ({ payjoin: {} }));
jest.mock('..', () => ({ addJsonRpcMethod: jest.fn() }));

jest.mock('../../lib/validate', () => ({
  isValidAddress: jest.fn(async () => true),
  isValidAmount: jest.fn(() => true),
  isValidBip21: jest.fn(() => true),
}));

jest.mock('../../lib/payjoin', () => ({
  parseBip21: jest.fn(() => ({
    pjUri: {},
    amount: 100_000n,
    address: 'bc1qsendaddress',
    expiry: new Date(Date.now() + 60_000),
  })),
  createSender: jest.fn(async () => ({ psbt: 'psbt' })),
  appendSendStatus: jest.fn((row: unknown) => row),
}));

jest.mock('../../lib/db', () => ({
  db: {
    send: {
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })),
    },
  },
}));

jest.mock('../../lib/globals', () => ({
  cnClient: { watch: jest.fn(async () => ({})) },
  lock: { acquire: jest.fn((_key: unknown, fn: () => unknown) => fn()) },
}));

jest.mock('../callback', () => ({
  addressCallbackUrl: jest.fn((type: string, address: string, token?: string) =>
    `http://payjoin:8000/${type}/address/${address}${token ? `?token=${token}` : ''}`
  ),
}));

jest.mock('../../lib/Log2File', () => ({
  __esModule: true,
  default: {
    silly: jest.fn(), trace: jest.fn(), debug: jest.fn(),
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('../../lib/db');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnClient } = require('../../lib/globals');

it('allows callback read-back while the session lock is held', async () => {
  const { lock } = require('../../lib/globals');
  const implementation = lock.acquire.getMockImplementation();
  lock.acquire.mockImplementation(() => { throw new Error('session lock held'); });
  try {
    registerSendApi();
    const getSend = (addJsonRpcMethod as jest.Mock).mock.calls.find(([name]) => name === 'getSend')[1];
    db.send.findUnique.mockResolvedValue({ id: 1035, confirmedTs: new Date() });
    await expect(getSend({ id: 1035 })).resolves.toMatchObject({ id: 1035, confirmedTs: expect.any(Date) });
  } finally {
    lock.acquire.mockImplementation(implementation);
  }
});

describe('send callback token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores a random token and includes it in both watch callback URLs', async () => {
    await send({ bip21: 'bitcoin:bc1qsendaddress?amount=0.001&pj=https://example.com' });

    expect(db.send.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ callbackToken: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    });
    const storedToken = db.send.create.mock.calls[0][0].data.callbackToken;
    const expectedUrl = `http://payjoin:8000/send/address/bc1qsendaddress?token=${storedToken}`;
    expect(cnClient.watch).toHaveBeenCalledWith({
      address: 'bc1qsendaddress',
      unconfirmedCallbackURL: expectedUrl,
      confirmedCallbackURL: expectedUrl,
    });
  });
});

describe('validateBip21', () => {
  const bip21 = 'bitcoin:bc1qsendaddress?pj=https://example.com';

  beforeEach(() => jest.clearAllMocks());

  afterEach(() => {
    expect(db.send.create).not.toHaveBeenCalled();
    expect(createSender).not.toHaveBeenCalled();
    expect(cnClient.watch).not.toHaveBeenCalled();
    expect(isValidAddress).not.toHaveBeenCalled();
  });

  it('accepts a parsed URI without requiring an amount', () => {
    jest.mocked(parseBip21).mockReturnValueOnce({
      ...parseBip21(bip21), amount: 0n,
    });
    expect(validateBip21({ bip21 })).toEqual({ isvalid: true, bip21 });
  });

  it('returns an invalid result for SDK parsing failures', () => {
    jest.mocked(parseBip21).mockImplementationOnce(() => { throw new Error('bad endpoint'); });
    expect(validateBip21({ bip21 })).toEqual({ isvalid: false, bip21, reason: 'Invalid bip21' });
  });

  it('rejects expiry in both validation and send before side effects', async () => {
    const expired = { ...parseBip21(bip21), expiry: new Date(0) };
    jest.mocked(parseBip21).mockReturnValueOnce(expired).mockReturnValueOnce(expired);
    expect(validateBip21({ bip21 })).toEqual({ isvalid: false, bip21, reason: 'bip21 has already expired' });
    await expect(send({ bip21 })).rejects.toMatchObject({ code: -32602, message: 'bip21 has already expired' });
  });
});
