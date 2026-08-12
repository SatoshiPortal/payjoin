import { payjoin } from 'payjoin';
import logger from './Log2File';
import { cnClient } from "./globals";
import { config } from "../config";

export function isValidBip21(bip21: string): boolean {
  logger.info(isValidBip21, bip21);

  try {
    const uri = payjoin.Uri.parse(bip21);
    uri.checkPjSupported();
  } catch (e) {
    logger.error(isValidBip21, 'Failed to parse bip21:', e);
    return false;
  }

  return true;
}

export async function isValidAddress(address: string): Promise<boolean> {
  logger.info(isValidAddress, address);

  try {
    const { result, error } = await cnClient.validateAddress(address);
    if (error) {
      logger.error(isValidAddress, 'Failed to validate address:', error);
      return false;
    }

    return result?.isvalid || false;
  } catch (e) {
    logger.error(isValidAddress, 'Failed to validate address:', e);
  }

  return false;
}

/**
 * Ownership check for a caller-supplied receive address.
 *
 * A payjoin receiver contributes one of its own UTXOs and the SDK adds that
 * value to the output paying the session's receive address — so an address we
 * do not own is a direct drain of the receive wallet, one UTXO per session.
 * `isValidAddress` only checks format, hence this.
 *
 * Cyphernode exposes no wallet-enumeration endpoint, so the wallet set comes
 * from config (OWNED_WALLETS). Every probe that doesn't come back with a
 * definitive `ismine` counts as not-owned, so a gatekeeper outage or a wallet
 * index that isn't loaded (bitcoind -18) fails closed.
 */
export async function isOwnedAddress(address: string): Promise<boolean> {
  logger.info(isOwnedAddress, address);

  // RECEIVE_WALLET first so the common case costs a single gatekeeper call.
  const wallets = [...new Set([config.RECEIVE_WALLET, ...config.OWNED_WALLETS])];

  for (const wallet of wallets) {
    try {
      const { result, error } = await cnClient.getAddressInfo({ address, wallet });

      if (error) {
        logger.warn(isOwnedAddress, `getAddressInfo failed for wallet ${wallet}:`, error);
        continue;
      }

      if (result?.ismine) {
        logger.info(isOwnedAddress, `address is owned by wallet ${wallet}`);
        return true;
      }
    } catch (e) {
      logger.error(isOwnedAddress, `getAddressInfo threw for wallet ${wallet}:`, e);
    }
  }

  logger.warn(isOwnedAddress, `address is not owned by any of ${wallets.join(',')}`);

  return false;
}

export function isValidAmount(amount: number | bigint): boolean {
  logger.info(isValidAmount, amount);

  return amount > 0;
}
