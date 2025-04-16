import { config } from "../config";
import { BtcUri, PayjoinOhttpKeys, PayjoinReceiver, PayjoinSender, PayjoinSenderBuilder } from "payjoin-ts";
import Utils from "./Utils";
import { Receive, Send } from "@prisma/client";
import { ReceiveStatus, SendStatus } from "../types/payjoin";
import { IRespReceive } from "../types/api/receive";
import { IRespSend } from "../types/api/send";
import { cnClient } from "./globals";

export async function getOhttpKeys() {
  const ohttpKeys = await PayjoinOhttpKeys.fetch(config.OHTTP_RELAY, config.PAYJOIN_DIRECTORY);
  return ohttpKeys.toBytes();
}

export async function createReceiver(address: string, amount: bigint): Promise<{ receiver: PayjoinReceiver, bip21: string }> {
  const ohttpKeys = await getOhttpKeys();

  const receiver = new PayjoinReceiver(
    address,
    config.PAYJOIN_DIRECTORY,
    ohttpKeys,
    config.OHTTP_RELAY,
    config.PAYJOIN_EXPIRY,
  );

  const uriBuilder = receiver.pjUriBuilder().amount(Number(amount));
  const bip21 = uriBuilder.build();

  return { receiver, bip21 };
}

export async function createSender(bip21: string): Promise<{ 
  sender: PayjoinSender, 
  amount: bigint, 
  address: string, 
  psbt: string 
}> {
  const bip21Uri = BtcUri.tryFrom(bip21);
  const checkedUri = await bip21Uri.assumeChecked();
  const pjUri = await checkedUri.checkPjSupported();

  const amount = BigInt(pjUri.amount() ?? 0);
  const address = pjUri.address() ?? '';

  const { error: feeError, result: feeResult } = await cnClient.getFeeRate({
    confTarget: 6,
  });
  if (feeError || !feeResult) {
    throw new Error(`Failed to get fee rate: ${feeError}`);
  }

  const { error: psbtError, result: psbtResult } = await cnClient.createFundedPsbt({
    inputs: [],
    outputs: {
      [address]: Utils.satsToBtc(amount),
    },
    options: {
      fee_rate: Number(feeResult.feerate),
      replaceable: true,
    },
    wallet: config.SEND_WALLET,
  });

  if (psbtError || !psbtResult) {
    throw new Error(`Failed to create funded psbt: ${psbtError}`);
  }

  const { error: processedPsbtError, result: processedPsbtResult } = await cnClient.processPsbt({
    psbt: psbtResult.psbt,
    sign: true,
    finalize: true,
    wallet: config.SEND_WALLET,
  });

  if (processedPsbtError || !processedPsbtResult) {
    throw new Error(`Failed to process psbt: ${processedPsbtError}`);
  }

  const psbt = processedPsbtResult.psbt;

  const builder = PayjoinSenderBuilder.fromPsbtAndUri(psbt, bip21);
  const sender = await builder.buildRecommended(1.0); // Number(feeResult.feerate)); // @todo get fee rate via cnClient

  return {
    sender,
    amount,
    address,
    psbt,
  }
}

export function appendReceiveStatus(receive: Receive) {
  let status = ReceiveStatus.Pending;
  if (!receive.txid && !receive.confirmedTs && receive.expiryTs && receive.expiryTs < new Date()) {
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
  } as IRespReceive;
}

export function appendSendStatus(send: Send) {
  let status = SendStatus.Pending;
  if (!send.txid && !send.confirmedTs && send.expiryTs && send.expiryTs < new Date()) {
    status = SendStatus.Expired;
  } else if (send.confirmedTs) {
    status = SendStatus.Confirmed;
  } else if (send.txid) {
    status = SendStatus.Unconfirmed;
  } else if (send.cancelledTs) {
    status = SendStatus.Cancelled;
  }

  return {
    ...Utils.omit(send, ['session']),
    status
  } as IRespSend;
}