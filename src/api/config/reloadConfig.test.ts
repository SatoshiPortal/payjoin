import { reloadConfig } from './reloadConfig';

jest.mock('../../config', () => ({
  reloadConfig: jest.fn(),
}));

jest.mock('../../cron', () => ({
  startCron: jest.fn(),
}));

jest.mock('../../lib/globals', () => ({
  cnClient: { configureCyphernode: jest.fn() },
  syncCnClient: { configureCyphernode: jest.fn() },
}));

jest.mock('../../lib/Log2File', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reloadConfig: execReloadConfig } = require('../../config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startCron } = require('../../cron');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnClient, syncCnClient } = require('../../lib/globals');

describe('reloadConfig RPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconfigures internal consumers without returning configuration values', async () => {
    const config = {
      CN_API_ID: '003',
      CN_API_KEY: 'secret-api-key',
      DATABASE_URL: 'postgresql://user:password@example/payjoin',
    };
    execReloadConfig.mockReturnValue(config);

    const result = await reloadConfig();

    expect(cnClient.configureCyphernode).toHaveBeenCalledWith(config);
    expect(syncCnClient.configureCyphernode).toHaveBeenCalledWith(config);
    expect(startCron).toHaveBeenCalledWith(config);
    expect(result).toEqual({ reloaded: true });
    expect(JSON.stringify(result)).not.toContain('secret-api-key');
    expect(JSON.stringify(result)).not.toContain('password');
  });
});
