import AsyncLock from "async-lock";
import { AxiosHeaders } from "axios";
import { config } from "../../config";
import { CyphernodeClient } from "../../lib/CyphernodeClient";
import { db } from "../../lib/db";
import logger from "../../lib/Log2File";
import Utils from "../../lib/Utils";

const lock = new AsyncLock();
const cnClient = new CyphernodeClient(config);

export function txCallbackUrl(txid: string) {
  return `${config.URL_SERVER}:${config.URL_PORT}/tx/${txid}`;
}

export async function handleTxCallback(tx: any) {
  const { txid, confirmations } = tx;

  await lock.acquire(txid, async () => {
    /*// get payments linked to this txid that have not been marked as confirmed or called back
    const payments = await db.payment.findMany({
      where: {
        txid,
        OR: [
          { confirmedTs: null },
          {
            AND: [
              { calledBackTs: null },
              { callbackUrl: { not: null } }
            ]
          }
        ]
      }
    });

    logger.info(handleTxCallback, `Found ${payments.length} payments for txid: ${txid}`);

    let errors = false;

    // get payments that haven't been marked as confirmed and update the records
    const unconfirmed = payments.filter(payment => !payment.confirmedTs);
    for (const payment of unconfirmed) {
      await db.payment.update({
        where: { id: payment.id },
        data: {
          confirmedTs: new Date()
        }
      }).catch((e: any) => {
        logger.error(handleTxCallback, `Failed to update payment ${payment.id} as confirmed:`, e);
        errors = true;
      });
    };

    // get payments that haven't been marked as called back and execute the callback then update the record
    const uncalledBack = payments.filter(payment => !payment.calledBackTs);
    for (const payment of uncalledBack) {
      const { callbackUrl } = payment;

      const postData = {
        address: payment.address,
        amount: payment.amount,
        txid,
        confirmations,
      };

      Utils.post(callbackUrl, postData, new AxiosHeaders({
        "Content-Type": "application/json",
      })).then(() => {
        db.payment.update({
          where: { id: payment.id },
          data: {
            calledBackTs: new Date()
          }
        });
      }).catch((e: any) => {
        logger.error(handleTxCallback, `Failed to call back to ${callbackUrl}:`, e);
        errors = true;
      });
    }

    // stop watching the tx
    if (!errors) {
      cnClient.unwatchtxid({
        txid,
        confirmedCallbackURL: txCallbackUrl(txid),
        xconfCallbackURL: txCallbackUrl(txid),
       });

    }*/
  });
}
