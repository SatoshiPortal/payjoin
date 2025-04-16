import { addJsonRpcMethod } from "..";
import { IReqReceive, IRespReceive } from "../../types/api/receive";
import { isValidAddress, isValidAmount } from "../../lib/validate";
import logger from "../../lib/Log2File";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { appendReceiveStatus, createReceiver } from "../../lib/payjoin";
import { config } from "../../config";
import { db } from "../../lib/db";
import { addressCallbackUrl } from "../callback";
import { lock, cnClient } from "../../lib/globals";

export function registerReceiveApi(): void {
  addJsonRpcMethod('receive', receive);
  addJsonRpcMethod('cancelReceive', cancelReceive);
}

export async function receive(params: IReqReceive): Promise<IRespReceive> {
  logger.info(receive, params);

  if (!params.address) {
    const { error: addressError, result: addressResult } = await cnClient.getnewaddress({ wallet: config.RECEIVE_WALLET});

    if (addressError || !addressResult) {
      logger.error(receive, 'Failed to get new address:', addressError);
      throw new JSONRPCErrorException('Failed to get new address', JSONRPCErrorCode.InternalError);
    }

    params.address = addressResult.address;
  }

  if (!isValidAddress(params.address)) {
    throw new JSONRPCErrorException('Invalid address', JSONRPCErrorCode.InvalidParams);
  }

  if (!isValidAmount(params.amount)) {
    throw new JSONRPCErrorException('Invalid amount', JSONRPCErrorCode.InvalidParams);
  }

  try {
    const { bip21, receiver } = await createReceiver(params.address, params.amount);
    const sessionJson = receiver.toJson();

    const data = {
      bip21,
      amount: params.amount,
      address: params.address,
      callbackUrl: params.callbackUrl,
      expiryTs: new Date(Date.now() + Number(config.PAYJOIN_EXPIRY) * 1000), // @todo should ideally extract this from the bip21
      session: sessionJson
    }

    const receive = await db.receive.create({ data });

    // watch the address for non-payjoin transactions
    const watchUrl = addressCallbackUrl('receive', params.address);
    await cnClient.watch({
      address: params.address,
      unconfirmedCallbackURL: watchUrl,
      confirmedCallbackURL: watchUrl,
    });

    // Use type assertion to handle null vs undefined discrepancy
    return appendReceiveStatus(receive as unknown as Parameters<typeof appendReceiveStatus>[0]);
  } catch (e) {
    logger.error(receive, 'Failed to receive:', e);
    throw new JSONRPCErrorException('Failed to receive', JSONRPCErrorCode.InternalError);
  }
}

async function cancelReceive(params: { id: number }): Promise<{ id: number }> {
  logger.info(cancelReceive, params);

  return new Promise((resolve, reject) => {
    lock.acquire(params.id.toString(), async () => {
      try {
        const { id } = params;

        const receive = await db.receive.findUnique({ where: { id } });

        if (!receive) {
          throw new JSONRPCErrorException('Receive session not found', JSONRPCErrorCode.InvalidParams);
        }
        if (receive.confirmedTs) {
          throw new JSONRPCErrorException('Cannot cancel a confirmed receive session', JSONRPCErrorCode.InvalidParams);
        }
        if (receive.txid) {
          throw new JSONRPCErrorException('Cannot cancel a completed (unconfirmed) receive session', JSONRPCErrorCode.InvalidParams);
        }
        if (receive.expiryTs && receive.expiryTs < new Date()) {
          throw new JSONRPCErrorException('Cannot cancel an expired receive session', JSONRPCErrorCode.InvalidParams);
        }
        if (receive.cancelledTs) {
          throw new JSONRPCErrorException('Receive session already cancelled', JSONRPCErrorCode.InvalidParams);
        }

        const result = await db.receive.update({
          data: {
            cancelledTs: new Date(),
          },
          where: { id } 
        });

        if (!result) {
          throw new JSONRPCErrorException('Failed to cancel receive session', JSONRPCErrorCode.InternalError);
        }

        // stop watching the address
        const watchUrl = addressCallbackUrl('receive', receive.address);
        await cnClient.unwatch({
          address: receive.address,
          unconfirmedCallbackURL: watchUrl,
          confirmedCallbackURL: watchUrl,
        });

        return { id };
      } catch (e) {
        logger.error(cancelReceive, 'Failed to cancel receive:', e);
        throw new JSONRPCErrorException('Failed to cancel receive', JSONRPCErrorCode.InternalError);
      }
    })
    .then(resolve)
    .catch(reject);
  });
}