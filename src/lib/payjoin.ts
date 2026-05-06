import { config } from "../config";
import { payjoin } from "payjoin";
import Utils from "./Utils";
import { Receive, Send } from "@prisma/client";
import { ReceiveStatus, SendStatus } from "../types/payjoin";
import { IRespReceive } from "../types/api/receive";
import { IRespSend } from "../types/api/send";
import { cnClient } from "./globals";
import IRespDecodePsbt from "../types/cyphernode/IRespDecodePsbt";

import axios, { AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from "./Log2File";
import { decodeBech32NoChecksum, decodeU32LE } from "./bech32";
import { ReceiverPersister, SenderPersister } from "./persister";
import { db } from "./db";

async function fetchOhttpKeys(
  ohttpRelay: string,
  payjoinDirectory: string
): Promise<Uint8Array> {
  const ohttpKeysUrl = new URL(payjoinDirectory).origin + '/.well-known/ohttp-gateway';
  const proxyAgent = new HttpsProxyAgent(ohttpRelay);
  const response: AxiosResponse = await axios.get(ohttpKeysUrl, {
    httpsAgent: proxyAgent,
    timeout: 10000,
    headers: {
      Accept: 'application/ohttp-keys'
    },
    responseType: 'arraybuffer'
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Unexpected status code: ${response.status}`);
  }
  return new Uint8Array(response.data);
}

export async function getOhttpKeys() {
  logger.debug(getOhttpKeys, 'Fetching OHTTP keys from relay:', config.OHTTP_RELAY, 'and directory:', config.PAYJOIN_DIRECTORY);
  const ohttpKeys = await fetchOhttpKeys(config.OHTTP_RELAY, config.PAYJOIN_DIRECTORY);
  logger.debug(getOhttpKeys, 'Fetched OHTTP keys successfully');
  return payjoin.OhttpKeys.decode(ohttpKeys.buffer as ArrayBuffer);
}

export async function fetchBufferResponse(request: { url: string, contentType: string, body: any }): Promise<ArrayBuffer> {
    const axiosResponse = await axios.post(request.url, request.body, {
        headers: { "Content-Type": request.contentType },
        responseType: 'arraybuffer'
    });
    return axiosResponse.data;
}

export function arrayBufferToHex(buffer: ArrayBuffer): string {
    const byteArray = new Uint8Array(buffer);
    const hexCodes = [...byteArray].map(value => value.toString(16).padStart(2, '0'));
    return hexCodes.join('');
}

export async function createReceiver({ id, address, amount }: { id: number | string, address: string, amount: bigint }): Promise<{ bip21: string }> {
  logger.info(createReceiver, `Creating receiver for address: ${address} amount: ${amount}`);

  const ohttpKeys = await getOhttpKeys();

  const persister = new ReceiverPersister({ id, db });

  const receiver = new payjoin.ReceiverBuilder(address, config.PAYJOIN_DIRECTORY, ohttpKeys)
    .withAmount(amount)
    .withExpiration(config.PAYJOIN_RECEIVE_EXPIRY)
    .build()
    .save(persister);


  if (!receiver) {
    throw new Error('Receiver initialization failed');
  }

  const bip21 = receiver.pjUri().asString();

  return { bip21 };
}

export function parseBip21(bip21: string): { pjUri: payjoin.PjUriInterface, amount: bigint, address: string, expiry: Date } {
  const uri = payjoin.Uri.parse(bip21);
  const pjUri = uri.checkPjSupported();

  const amount = BigInt(pjUri.amountSats() ?? 0);
  const address = pjUri.address() ?? '';
  const pj = pjUri.pjEndpoint();
  const exp = extractExpiry(pj);
  const expiry = exp ? new Date(Number(exp) * 1000) : new Date(Date.now() + 3600 * 1000); // default to 1 hour if not set
  logger.debug('calculated expiry date:', expiry.toISOString());
  
  return { pjUri, amount, address, expiry };
}

export async function createSender({id, pjUri, amount, address }: { id: number | string, pjUri: payjoin.PjUriInterface, amount: bigint, address: string }): Promise<{ 
  psbt: string 
}> {
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
      lockUnspents: true,
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

  const persister = new SenderPersister({ id, db });

  new payjoin.SenderBuilder(psbt, pjUri)
    .buildRecommended(1n)
    .save(persister);

  return {
    psbt,
  }
}

export function appendReceiveStatus(receive: Receive) {
  let status = ReceiveStatus.Pending;
  if (receive.cancelledTs) {
    status = ReceiveStatus.Cancelled;
  } else if (receive.confirmedTs) {
    status = ReceiveStatus.Confirmed;
  } else if (receive.fallbackTs) {
    status = ReceiveStatus.Fallback;
  } else if (receive.nonPayjoinTs) {
    status = ReceiveStatus.NonPayjoin;
  } else if (receive.txid) {
    status = ReceiveStatus.Unconfirmed;
  } else if (!receive.txid && !receive.confirmedTs && receive.expiryTs && receive.expiryTs < new Date()) {
    status = ReceiveStatus.Expired;
  }

  return {
    ...Utils.omit(receive, ['session']),
    status
  } as IRespReceive;
}

export function appendSendStatus(send: Send) {
  let status = SendStatus.Pending;
  if (send.cancelledTs) {
    status = SendStatus.Cancelled;
  } else if (send.confirmedTs) {
    status = SendStatus.Confirmed;
  } else if (send.txid) {
    status = SendStatus.Unconfirmed;
  } else if (!send.txid && !send.confirmedTs && send.expiryTs && send.expiryTs < new Date()) {
    status = SendStatus.Expired;
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

export function extractExpiry(pjEndpoint: string): number | null {
  try {
    const hashIndex = pjEndpoint.indexOf('#');
    if (hashIndex === -1) return null;

    const afterHash = pjEndpoint.substring(hashIndex + 1);
    const parts = afterHash.split('-');

    const ex1Part = parts.find(part => part.startsWith('EX1'));
    if (!ex1Part) return null;

    const { hrp, bytes } = decodeBech32NoChecksum(ex1Part);
    if (hrp !== 'ex') return null;
    if (bytes.length < 4) return null;

    const ts = decodeU32LE(bytes.slice(0, 4));
    return ts > 0 ? ts : null;
  } catch {
    return null;
  }
}
