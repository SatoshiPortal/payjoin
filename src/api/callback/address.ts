import AsyncLock from "async-lock";
//import { AxiosHeaders } from "axios";
import { config } from "../../config";
import { CyphernodeClient } from "../../lib/CyphernodeClient";
import { db } from "../../lib/db";
import logger from "../../lib/Log2File";
import Utils from "../../lib/Utils";

const lock = new AsyncLock();
const cnClient = new CyphernodeClient(config);

export function addressCallbackUrl(address: string) {
  return `${config.URL_SERVER}:${config.URL_PORT}/address/${address}`;
}

export async function handleAddressCallback(data: any) {
  logger.info(handleAddressCallback, "Received address callback:", JSON.stringify(data, null, 2));

  lock.acquire(data.address, async () => {
    /*try {
      let premix = await db.premixUtxo.findFirst({
        where: {
          address: data.address,
          confirmedTs: null 
        }
      });

      if (!premix) {
        logger.error(handleAddressCallback, "Premix utxo not found for address:", data.address);
        return;
      }

      // ensure we have the UTXO details as early as possible
      if (!premix.txid || premix.txid !== data.txid) {
        premix = await db.premixUtxo.update({
          where: { id: premix.id },
          data: {
            txid: data.txid,
            vout: data.vout_n,
            amount: Utils.btcToSats(data.sent_amount),
            locked: false,
            lockedTs: null,
          }
        });
      }

      if (!premix.locked) {
        /onst { result, error } = await cnClient.lockUnspent({
          utxos: [{
            txid: data.txid,
            vout: data.vout_n
          }],
          wallet: config.TRANSACTION_WALLET
        });

        if (error || !result?.success) {
          logger.error(handleAddressCallback, "Failed to lock utxo:", error);
        }

        if (result && result.success) {
          logger.info(handleAddressCallback, "UTXO locked");

          await db.premixUtxo.update({
            where: { id: premix.id },
            data: {
              locked: true,
              lockedTs: new Date()
            }
          });

        }
      }

      if (data.confirmations >= 1 && premix.confirmedTs === null) {
        await db.premixUtxo.update({
          where: { id: premix.id },
          data: {
            confirmedTs: new Date()
          }
        });
      }
    } catch (e) {
      logger.error(handleAddressCallback, "Failed to handle address callback:", e);
    }*/
  });
}