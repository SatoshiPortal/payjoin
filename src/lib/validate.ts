import { payjoin } from 'payjoin';
import logger from './Log2File';
import { cnClient } from "./globals";

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

export function isValidAmount(amount: number | bigint): boolean {
  logger.info(isValidAmount, amount);

  return amount > 0;
}
