import { config } from "../../config";
import { db } from "../../lib/db";
import logger from "../../lib/Log2File";
import Utils from "../../lib/Utils";
import { appendReceiveStatus } from "../../lib/payjoin";
import { lock, cnClient } from "../../lib/globals";
import { Receive } from "@prisma/client";

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
        }
      });

      if (!payjoin) {
        logger.error(handleAddressCallback, `payjoin ${type} not found for address: ${data.address}`);
        return;
      }

      if (type === "receive" && data.txid !== payjoin.txid) {
        let updatedPayjoin: Receive;
        if (payjoin.fallbackTs) {
          // this is a fallback tx
          logger.info(handleAddressCallback, "fallback transaction detected");
          updatedPayjoin = await db.receive.update({
            where: { id: payjoin.id },
            data: {
              amount: Utils.btcToSats(data.sent_amount), // update the amount here to ensure it matches the fallback tx
              receiverFee: 0n, // we contribute no fee in a fallback tx
              receiverInAmount: 0n,
              receiverOutAmount: 0n,
            }
          });
        } else {
          // this is a non-payjoin transaction
          logger.info(handleAddressCallback, "non-payjoin transaction detected");
          updatedPayjoin = await db.receive.update({
            where: { id: payjoin.id },
            data: {
              amount: Utils.btcToSats(data.sent_amount), // this amount could be anything not matching the payjoin amount
              receiverFee: 0n, // we contribute no fee in a non-payjoin tx
              receiverInAmount: 0n,
              receiverOutAmount: 0n,
              txid: data.txid,
              nonPayjoinTs: new Date(),
              cancelledTs: new Date(), // cancel it so we don't process the payjoin
            }
          });
          logger.info(handleAddressCallback, "cancelled receive session");
        }

        // send the callback data
        if (payjoin.callbackUrl) {
          const postData = Utils.sanitizeResponse(
            appendReceiveStatus(updatedPayjoin as unknown as Parameters<typeof appendReceiveStatus>[0])
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
      if (updatedPayjoin.confirmedTs) {
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