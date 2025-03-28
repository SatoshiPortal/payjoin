import { addJsonRpcMethod } from "..";
import { IReqReceive, IRespReceive } from "../../types/api/receive";
import { isValidAddress, isValidAmount } from "../../lib/validate";
import logger from "../../lib/Log2File";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { createReceiver } from "../../lib/payjoin";
import { config } from "../../config";
import { db } from "../../lib/db";
import { Receive } from "@prisma/client";
import Utils from "../../lib/Utils";

export function registerReceiveApi(): void {
  addJsonRpcMethod('receive', receive);
}

export async function receive(params: IReqReceive): Promise<IRespReceive> {
  logger.info(receive, params);

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

    return appendReceiveStatus(receive);
  } catch (e) {
    logger.error(receive, 'Failed to receive:', e);
    throw new JSONRPCErrorException('Failed to receive', JSONRPCErrorCode.InternalError);
  }
}

// @todo move both of these somehwere more appropriate
export enum ReceiveStatus {
  Pending = 'pending',
  Unconfirmed = 'unconfirmed',
  Confirmed = 'confirmed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export function appendReceiveStatus(receive: Receive) {
  let status = ReceiveStatus.Pending;
  if (receive.expiryTs < new Date()) {
    status = ReceiveStatus.Expired;
  } else if (receive.confirmedTs) {
    status = ReceiveStatus.Confirmed;
  } else if (receive.txid) {
    status = ReceiveStatus.Unconfirmed;
  } else if (receive.cancelledTs) {
    status = ReceiveStatus.Cancelled;
  }

  return {
    ...Utils.omit(receive, ['session']),
    status
  };
}