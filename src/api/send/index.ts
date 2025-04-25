import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { addJsonRpcMethod } from "..";
import logger from "../../lib/Log2File";
import { isValidBip21 } from "../../lib/validate";
import { IReqSend, IRespSend } from "../../types/api/send";
import { appendSendStatus, createSender } from "../../lib/payjoin";
import { config } from "../../config";
import { db } from "../../lib/db";
import { addressCallbackUrl } from "../callback";
import { lock, cnClient } from "../../lib/globals";

export function registerSendApi(): void {
  addJsonRpcMethod('send', send);
  addJsonRpcMethod('cancelSend', cancelSend);
  addJsonRpcMethod('getSend', getSend);
}

export async function send(params: IReqSend): Promise<IRespSend> {
  logger.info(send, params);

  if (!isValidBip21(params.bip21)) {
    throw new JSONRPCErrorException('Invalid bip21', JSONRPCErrorCode.InvalidParams);
  }

  try {
    const { sender, amount, address, expiry, psbt } = await createSender(params.bip21);

    logger.debug('sender:', sender);
    logger.debug('amount:', amount);
    logger.debug('address:', address);
    logger.debug('expiry:', expiry);
    logger.debug('psbt:', psbt);

    const sessionJson = sender.toJson();
    logger.debug('sessionJson:', sessionJson);

    const data = {
      bip21: params.bip21,
      amount,
      address,
      callbackUrl: params.callbackUrl,
      expiryTs: expiry,
      session: sessionJson
    }

    const send = await db.send.create({ data });

    // watch the address for non-payjoin transactions
    const watchUrl = addressCallbackUrl('send', address);
    await cnClient.watch({
      address,
      unconfirmedCallbackURL: watchUrl,
      confirmedCallbackURL: watchUrl,
    });

    return appendSendStatus(send);
  } catch (e) {
    logger.error(send, 'Failed to send:', e);
    throw new JSONRPCErrorException('Failed to send', JSONRPCErrorCode.InternalError, e);
  }
}

async function cancelSend(params: { id: number }): Promise<{ id: number }> {
  logger.info(cancelSend, params);

  return new Promise((resolve, reject) => {
    lock.acquire(params.id.toString(), async () => {
      try {
        const { id } = params;

        const send = await db.send.findUnique({ where: { id } });

        if (!send) {
          throw new JSONRPCErrorException('Send session not found', JSONRPCErrorCode.InvalidParams);
        }
        if (send.confirmedTs) {
          throw new JSONRPCErrorException('Cannot cancel a confirmed send session', JSONRPCErrorCode.InvalidParams);
        }
        if (send.txid) {
          throw new JSONRPCErrorException('Cannot cancel a completed (unconfirmed) send session', JSONRPCErrorCode.InvalidParams);
        }
        if (send.expiryTs && send.expiryTs < new Date()) {
          throw new JSONRPCErrorException('Cannot cancel an expired send session', JSONRPCErrorCode.InvalidParams);
        }
        if (send.cancelledTs) {
          throw new JSONRPCErrorException('Send session already cancelled', JSONRPCErrorCode.InvalidParams);
        }

        const result = await db.send.update({
          data: {
            cancelledTs: new Date(),
          },
          where: { id } 
        });

        if (!result) {
          throw new JSONRPCErrorException('Failed to cancel send session', JSONRPCErrorCode.InternalError);
        }

        // stop watching the address
        const watchUrl = addressCallbackUrl('send', send.address!);
        await cnClient.unwatch({
          address: send.address!,
          unconfirmedCallbackURL: watchUrl,
          confirmedCallbackURL: watchUrl,
        });

        return { id };
      } catch (e) {
        logger.error(cancelSend, 'Failed to cancel send:', e);
        throw new JSONRPCErrorException('Failed to cancel send', JSONRPCErrorCode.InternalError);
      }
    })
    .then(resolve)
    .catch(reject);
  });
}

async function getSend(params: { id: number }): Promise<{ id: number }> {
  logger.info(getSend, params);

  return new Promise((resolve, reject) => {
    lock.acquire(params.id.toString(), async () => {
      try {
        const { id } = params;

        const send = await db.send.findUnique({ where: { id } });

        if (!send) {
          throw new JSONRPCErrorException('Send session not found', JSONRPCErrorCode.InvalidParams);
        }

        return appendSendStatus(send);
      } catch (e) {
        logger.error(getSend, 'Failed to get send:', e);
        throw new JSONRPCErrorException('Failed to get send', JSONRPCErrorCode.InternalError);
      }
    })
    .then(resolve)
    .catch(reject);
  });
}