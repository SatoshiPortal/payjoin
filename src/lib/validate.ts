import { BtcUri } from 'payjoin-ts';
import logger from './Log2File';
import { cnClient } from "./globals";

export async function isValidBip21(bip21: string): Promise<boolean> {
  logger.info(isValidBip21, bip21);

  const isValid = /^bitcoin:([13][a-km-zA-HJ-NP-Z1-9]{25,34})(\?.+)?$/.test(bip21);
  if (!isValid) {
    return false;
  }

  try {
    const uri = BtcUri.tryFrom(bip21);
    if (!uri) {
      return false;
    }

    const checkedUri = uri.assumeChecked();
    if (!checkedUri) {
      return false;
    }

    // @todo payjoin-typescript types need updating. This should be async
    if (!(await checkedUri.checkPjSupported())) {
      return false;
    }
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