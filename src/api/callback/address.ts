import { config } from "../../config";
import { db } from "../../lib/db";
import logger from "../../lib/Log2File";
import Utils from "../../lib/Utils";
import { appendReceiveStatus } from "../../lib/payjoin";
import { lock, cnClient } from "../../lib/globals";

export function addressCallbackUrl(type: "send" | "receive", address: string) {
  return `${config.URL_SERVER}:${config.URL_PORT}/${type}/address/${address}`;
}

export async function handleAddressCallback(data: any, type: "send" | "receive") {
  logger.info(handleAddressCallback, "address callback:", JSON.stringify(data, null, 2));

  lock.acquire(data.address, async () => {
    const prismaModel: any = type === "send" ? db.send : db.receive;
    try {
      let payjoin = await prismaModel.findFirst({
        where: {
          address: data.address,
          confirmedTs: null,
          cancelledTs: null,
        }
      });

      if (!payjoin) {
        logger.error(handleAddressCallback, `payjoin ${type} not found for address: ${data.address}`);
        return;
      }

      if (type === "receive" && data.txid !== payjoin.txid) {
        // this is a non-payjoin transaction
        logger.info(handleAddressCallback, "non-payjoin transaction detected");
        const cancelledReceive = await db.receive.update({
          where: { id: payjoin.id },
          data: {
            txid: data.txid,
            cancelledTs: new Date(),
          }
        });
        logger.info(handleAddressCallback, "cancelled receive session");

        // send the callback data
        if (payjoin.callbackUrl) {
          const postData = Utils.sanitizeResponse(
            appendReceiveStatus(cancelledReceive as unknown as Parameters<typeof appendReceiveStatus>[0])
          )
          if (await Utils.post(payjoin.callbackUrl, postData)) {
            logger.info(handleAddressCallback, "callback sent to:", payjoin.callbackUrl);
            await db.receive.update({
              where: { id: payjoin.id },
              data: {
                calledBackTs: new Date()
              }
            });
          }
        }

        // stop watching the address
        const watchUrl = addressCallbackUrl(type, data.address);
        await cnClient.unwatch({
          address: data.address,
          unconfirmedCallbackURL: watchUrl,
          confirmedCallbackURL: watchUrl,
        });

        return;
      }

      // not updating the amount here - it will be different from the actual payjoin amount
      // @todo do we need to store it in a separate field?
      const updateData: any = {
        txid: data.txid,
        fee: Utils.btcToSats(data.fees), // this fee will be the total - but we'll want the split as well
      }
      if (type === "receive") {
        updateData.firstSeenTs = payjoin.firstSeenTs ?? new Date();
      }
      if (data.confirmations >= 1 && payjoin.confirmedTs === null) {
        updateData.confirmedTs = new Date();
      }

      const updatedPayjoin = await prismaModel.update({
        where: { id: payjoin.id },
        data: updateData
      });
      logger.info(handleAddressCallback, "updated payjoin record:", updatedPayjoin);

      // send the callback data
      if (updatedPayjoin.callbackUrl) {
        const postData = Utils.sanitizeResponse(
          appendReceiveStatus(updatedPayjoin as unknown as Parameters<typeof appendReceiveStatus>[0])
        )
        if (await Utils.post(updatedPayjoin.callbackUrl, postData)) {
          logger.info(handleAddressCallback, "callback sent to:", updatedPayjoin.callbackUrl);
          await prismaModel.update({
            where: { id: payjoin.id },
            data: {
              calledBackTs: new Date()
            }
          });
        }
      }

      // stop watching the address if tx is confirmed
      if (data.confirmations >= 1) {
        const watchUrl = addressCallbackUrl(type, data.address);
        await cnClient.unwatch({
          address: data.address,
          unconfirmedCallbackURL: watchUrl,
          confirmedCallbackURL: watchUrl,
        });
      }
    } catch (e) {
      logger.error(handleAddressCallback, "Failed to handle address callback:", e);
    }
  });
}