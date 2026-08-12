import { isOwnedAddress } from './validate';
import { config } from '../config';
import { cnClient } from './globals';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// payjoin is an ESM package — mock it so Jest can parse validate.ts. Only
// isValidBip21 touches the SDK, and these tests don't exercise it.
jest.mock('payjoin', () => ({ payjoin: {} }));

jest.mock('./globals', () => ({
  cnClient: {
    getAddressInfo: jest.fn(),
    validateAddress: jest.fn(),
  },
  syncCnClient: {},
  lock: {},
}));

jest.mock('./Log2File', () => ({
  __esModule: true,
  default: {
    silly: jest.fn(), trace: jest.fn(), debug: jest.fn(),
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
  },
}));

const getAddressInfo = cnClient.getAddressInfo as jest.Mock;

const ADDRESS = 'bcrt1qu2xt7tsqastdgv2pnresamwm4t6je5lgtmfkvh';

describe('isOwnedAddress', () => {
  const originalReceiveWallet = config.RECEIVE_WALLET;
  const originalOwnedWallets = config.OWNED_WALLETS;

  beforeEach(() => {
    jest.clearAllMocks();
    config.RECEIVE_WALLET = '02';
    config.OWNED_WALLETS = ['02', '01'];
  });

  afterAll(() => {
    config.RECEIVE_WALLET = originalReceiveWallet;
    config.OWNED_WALLETS = originalOwnedWallets;
  });

  it('accepts an address owned by RECEIVE_WALLET without probing other wallets', async () => {
    getAddressInfo.mockResolvedValue({ result: { ismine: true }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(true);

    expect(getAddressInfo).toHaveBeenCalledTimes(1);
    expect(getAddressInfo).toHaveBeenCalledWith({ address: ADDRESS, wallet: '02' });
  });

  it('accepts an address owned by a later wallet in the list', async () => {
    getAddressInfo
      .mockResolvedValueOnce({ result: { ismine: false }, error: null })
      .mockResolvedValueOnce({ result: { ismine: true }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(true);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
    expect(getAddressInfo).toHaveBeenNthCalledWith(2, { address: ADDRESS, wallet: '01' });
  });

  it('rejects when no wallet reports ismine', async () => {
    getAddressInfo.mockResolvedValue({ result: { ismine: false }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
  });

  it('treats a wallet that is not loaded (bitcoind -18) as not-owned and keeps probing', async () => {
    getAddressInfo
      .mockResolvedValueOnce({ error: { code: -18, message: 'Requested wallet does not exist or is not loaded' } })
      .mockResolvedValueOnce({ result: { ismine: true }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(true);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
  });

  // CyphernodeClient._post never rejects: a connection failure is caught inside
  // the client and returned as {status: -1}, which handleResponse turns into
  // this error object. Verified against the live gatekeeper.
  it('fails closed when the gatekeeper is unreachable', async () => {
    getAddressInfo.mockResolvedValue({
      error: { code: -32603, message: 'connect ECONNREFUSED 10.0.2.239:2009' },
    });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
  });

  // The throw path is only reachable if the client fails before its own
  // try/catch — e.g. fs.readFileSync of the gatekeeper CA cert throwing.
  it('fails closed when the client itself throws', async () => {
    getAddressInfo.mockRejectedValue(new Error('ENOENT: /payjoin/cert.pem'));

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
  });

  // A legacy watch-only address as Core actually reports it: ISMINE_WATCH_ONLY
  // and ISMINE_SPENDABLE are mutually exclusive, so the rejection comes from
  // `ismine: false` — `iswatchonly` is not consulted, and on a descriptor
  // wallet it would never be set in the first place.
  it('rejects a legacy watch-only address (reported as ismine: false)', async () => {
    getAddressInfo.mockResolvedValue({
      result: { ismine: false, iswatchonly: true, solvable: true },
      error: null,
    });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);
  });

  it('de-duplicates RECEIVE_WALLET against OWNED_WALLETS', async () => {
    config.OWNED_WALLETS = ['02', '02', '01'];
    getAddressInfo.mockResolvedValue({ result: { ismine: false }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);

    expect(getAddressInfo).toHaveBeenCalledTimes(2);
  });

  it('still probes RECEIVE_WALLET when OWNED_WALLETS omits it', async () => {
    config.OWNED_WALLETS = ['01'];
    getAddressInfo.mockResolvedValue({ result: { ismine: false }, error: null });

    await expect(isOwnedAddress(ADDRESS)).resolves.toBe(false);

    expect(getAddressInfo).toHaveBeenNthCalledWith(1, { address: ADDRESS, wallet: '02' });
    expect(getAddressInfo).toHaveBeenNthCalledWith(2, { address: ADDRESS, wallet: '01' });
  });
});
