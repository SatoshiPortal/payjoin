import { send } from './index';

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
