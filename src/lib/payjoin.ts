import { config } from "../config";
import { BtcUri, PayjoinOhttpKeys, PayjoinReceiver, PayjoinSender, PayjoinSenderBuilder, PayjoinUri } from "payjoin-ts";
import Utils from "./Utils";
import { Receive, Send } from "@prisma/client";
import { ReceiveStatus, SendStatus } from "../types/payjoin";
import { IRespReceive } from "../types/api/receive";
import { IRespSend } from "../types/api/send";
import { cnClient } from "./globals";
import IRespDecodePsbt from "../types/cyphernode/IRespDecodePsbt";

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
    config.PAYJOIN_RECEIVE_EXPIRY,
  );

  const uriBuilder = receiver.pjUriBuilder().amount(Number(amount));
  const bip21 = uriBuilder.build();

  return { receiver, bip21 };
}

export async function createSender(bip21: string): Promise<{ 
  sender: PayjoinSender, 
  amount: bigint, 
  address: string, 
  expiry: Date,
  psbt: string 
}> {
  const bip21Uri = BtcUri.tryFrom(bip21);
  const checkedUri = await bip21Uri.assumeChecked();
  const pjUri = await checkedUri.checkPjSupported();

  const amount = BigInt(pjUri.amount() ?? 0);
  const address = pjUri.address() ?? '';
  const exp = pjUri.exp();
  const expiry = exp ? new Date(Number(exp) * 1000) : new Date(Date.now() + 3600 * 1000); // default to 1 hour if not set

  const { error: feeError, result: feeResult } = await cnClient.getFeeRate({
    confTarget: 1,
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
    expiry,
    psbt,
  }
}

export function appendReceiveStatus(receive: Receive) {
  let status = ReceiveStatus.Pending;
  if (!receive.txid && !receive.confirmedTs && receive.expiryTs && receive.expiryTs < new Date()) {
    status = ReceiveStatus.Expired;
  } else if (receive.confirmedTs) {
    status = ReceiveStatus.Confirmed;
  } else if (receive.fallbackTs) {
    status = ReceiveStatus.Fallback;
  } else if (receive.nonPayjoinTs) {
    status = ReceiveStatus.NonPayjoin;
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

export function extractFeeFromPsbt(decodedPsbt: NonNullable<IRespDecodePsbt['result']>) {
  if (decodedPsbt.fee) {
    return Utils.btcToSats(decodedPsbt.fee);
  }

  // calculate the total input amount
  const totalInputAmount = decodedPsbt.inputs
    .filter((input) => input.witness_utxo)
    .reduce((acc, input) => acc + Utils.btcToSats(input.witness_utxo?.amount || 0), 0n);

  // calculate the total output amount
  const totalOutputAmount = decodedPsbt.tx.vout
    .reduce((acc, output) => acc + Utils.btcToSats(output.value || 0), 0n);

  // calculate the fee
  const fee = totalInputAmount - totalOutputAmount;

  return fee;
}
