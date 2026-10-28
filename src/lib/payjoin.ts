import { config } from "../config";
import { payjoin } from "payjoin";
import Utils from "./Utils";
import { Receive, Send } from "@prisma/client";
import { ReceiveStatus, SendStatus } from "../types/payjoin";
import { IRespReceive } from "../types/api/receive";
import { IRespSend } from "../types/api/send";
import { cnClient } from "./globals";
import IRespDecodePsbt from "../types/cyphernode/IRespDecodePsbt";

import axios, { AxiosError, AxiosResponse } from 'axios';
import { randomInt } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from "./Log2File";
import { decodeBech32NoChecksum, decodeU32LE } from "./bech32";
import { ReceiverPersister, SenderPersister } from "./persister";
import { db } from "./db";

/** Fisher-Yates shuffle (returns a new array) — randomizes initial relay choice to avoid a deterministic fingerprint. */
function shuffled<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Group subdomains by operator, conservatively grouping multi-label public suffixes.
function serverDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes('%') || host.split('.').some(label => !label)) {
    throw new Error('Unreadable payjoin server host');
  }
  return host.includes(':') || /^[\d.]+$/.test(host) ? host : host.split('.').slice(-2).join('.');
}

export async function withRelayFallback<T>(directory: string, fn: (relay: string) => Promise<T>, longPoll = false): Promise<{ result: T; relay: string }> {
  const domain = serverDomain(directory);
  const relays = shuffled(config.PAYJOIN_SERVERS.filter(relay => serverDomain(relay) !== domain));
  if (!relays.length) throw new Error('No OHTTP relay outside the directory domain');
  let lastError: unknown;
  for (const relay of relays) {
    try {
      const result = await fn(relay);
      return { result, relay };
    } catch (e) {
      if (longPoll && e instanceof AxiosError && e.code === 'ECONNABORTED') throw e;
      logger.warn(withRelayFallback, `Relay ${relay} failed, trying next:`, e);
      lastError = e;
    }
  }
  throw lastError;
}

async function fetchOhttpKeys(
  ohttpRelay: string,
  payjoinDirectory: string,
  timeoutMs: number
): Promise<Uint8Array> {
  const ohttpKeysUrl = new URL(payjoinDirectory).origin + '/.well-known/ohttp-gateway';
  const proxyAgent = new HttpsProxyAgent(ohttpRelay);
  const response: AxiosResponse = await axios.get(ohttpKeysUrl, {
    httpsAgent: proxyAgent,
    timeout: timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
    maxRedirects: 0,
    proxy: false,
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
  const deadline = Date.now() + 30000;
  let lastError: unknown;
  for (const directory of shuffled(config.PAYJOIN_SERVERS)) {
    try {
      const { result: keys, relay } = await withRelayFallback(directory, async (relay) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Payjoin directory discovery timed out');
        const buffer = await fetchOhttpKeys(relay, directory, Math.min(config.OHTTP_RELAY_TIMEOUT_MS, remaining));
        return payjoin.OhttpKeys.decode(buffer.buffer as ArrayBuffer);
      });
      return { keys, relay, directory };
    } catch (e) {
      lastError = e;
      if (Date.now() >= deadline) break;
    }
  }
  throw lastError ?? new Error('No payjoin directories configured');
}

/** Keep each response paired with the OHTTP context of the successful attempt. */
export async function fetchSessionResponse<T extends { request: { url: string; contentType: string; body: any } }>(
  bip21: string, createRequest: (relay: string) => T, longPoll = false
): Promise<{ rr: T; responseBuffer: ArrayBuffer }> {
  const directory = payjoin.Uri.parse(bip21).checkPjSupported().pjEndpoint();
  const { result } = await withRelayFallback(directory, async (relay) => {
    const rr = createRequest(relay);
    const responseBuffer = await fetchBufferResponse(rr.request, longPoll ? config.OHTTP_LONGPOLL_TIMEOUT_MS : config.OHTTP_RELAY_TIMEOUT_MS);
    return { rr, responseBuffer };
  }, longPoll);
  return result;
}

export async function fetchBufferResponse(request: { url: string, contentType: string, body: any }, timeoutMs: number = config.OHTTP_RELAY_TIMEOUT_MS): Promise<ArrayBuffer> {
    const axiosResponse = await axios.post(request.url, request.body, {
        headers: { "Content-Type": request.contentType },
        responseType: 'arraybuffer',
        maxRedirects: 0,
        proxy: false,
        timeout: timeoutMs,
    });
    return axiosResponse.data;
}

export function arrayBufferToHex(buffer: ArrayBuffer): string {
    const byteArray = new Uint8Array(buffer);
    const hexCodes = [...byteArray].map(value => value.toString(16).padStart(2, '0'));
    return hexCodes.join('');
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
    return new Uint8Array(Buffer.from(hex, 'hex')).buffer;
}

/**
 * Extract a useful, human-readable message from an error thrown by the payjoin
 * WASM/FFI bindings.
 *
 * The uniffi-generated tagged-enum errors (e.g. `ReceiverPersistedError`) set
 * `message` to just the variant name — "ReceiverPersistedError.Storage" — which
 * tells us nothing about what actually went wrong. The real detail lives in the
 * `inner` array, which holds opaque WASM error objects (e.g. `ImplementationError`)
 * that JSON-serialize to `{}` but expose the underlying Rust `Display`/`Debug`
 * strings via `toString()` / `toDebugString()`.
 *
 * Note: due to an upstream payjoin-ffi quirk (`impl_save_for_transition!` wraps the
 * whole `PersistedError` in an `ImplementationError`), genuine protocol/API errors —
 * such as a `check_broadcast_suitability` rejection — also surface under the
 * `Storage` tag. Reading the inner `Display` string is what recovers the real reason
 * (e.g. "Fatal error: ... PSBT rejected by mempool").
 */
export function describePayjoinError(e: unknown): string {
  // uniffi tagged-enum error: prefer the inner WASM error detail over the bare variant name.
  if (e && typeof e === 'object' && 'tag' in e) {
    const tag = String((e as { tag: unknown }).tag);
    const rawInner = (e as { inner?: unknown }).inner;
    const items = Array.isArray(rawInner) ? rawInner : rawInner != null ? [rawInner] : [];
    const detail = items.map(stringifyWasmError).filter(Boolean).join('; ');
    const name = e instanceof Error && e.name ? e.name : 'PayjoinError';
    return detail ? `${name}.${tag}: ${detail}` : `${name}.${tag}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function stringifyWasmError(item: unknown): string {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item !== 'object') return String(item);

  const obj = item as { toDebugString?: () => string; toString?: () => string };
  // toDebugString() -> Rust Debug (most detail); toString() -> Rust Display.
  try {
    if (typeof obj.toDebugString === 'function') {
      const s = obj.toDebugString();
      if (s) return s;
    }
  } catch { /* WASM handle may be unavailable — fall through */ }
  try {
    if (typeof obj.toString === 'function' && obj.toString !== Object.prototype.toString) {
      const s = obj.toString();
      if (s && s !== '[object Object]') return s;
    }
  } catch { /* fall through */ }
  try {
    const j = JSON.stringify(item);
    if (j && j !== '{}') return j;
  } catch { /* ignore */ }
  return '';
}

/**
 * Extract the actual protocol error from a persisted receiver session log.
 *
 * When a receiver check rejects the original payload (e.g. broadcast suitability), the SDK
 * appends a `GotReplyableError` event before moving to the `HasReplyableError` state. That
 * event is the authoritative reason — far more useful than the generic
 * `ReceiverPersistedError` that surfaces through the throw path, and the `HasReplyableError`
 * state object exposes no getter for it.
 *
 * Events are stored as a JSON array of JSON-encoded event strings, each shaped like
 * `{"GotReplyableError":{"error_code":"...","message":"...","extra":{}}}`. Returns the most
 * recent one formatted as "error_code: message", or undefined if none is present.
 */
export function extractReplyableError(sessionJson: string | null | undefined): string | undefined {
  if (!sessionJson) return undefined;
  let events: unknown;
  try { events = JSON.parse(sessionJson); } catch { return undefined; }
  if (!Array.isArray(events)) return undefined;

  let reason: string | undefined;
  for (const ev of events) {
    let parsed: unknown;
    try { parsed = typeof ev === 'string' ? JSON.parse(ev) : ev; } catch { continue; }
    const err = (parsed as { GotReplyableError?: { error_code?: string; message?: string } })?.GotReplyableError;
    if (err) {
      reason = err.message
        ? (err.error_code ? `${err.error_code}: ${err.message}` : err.message)
        : err.error_code;
    }
  }
  return reason;
}

/**
 * Extract the receiver input committed to the payjoin proposal from the
 * session event log (issue #8).
 *
 * The FFI's `tryPreservingPrivacy` return value exposes no outpoint accessors,
 * so the committed input can only be identified from the `CommittedInputs`
 * event that `commitInputs()` persists. Each event is a JSON-encoded string
 * shaped like `{"CommittedInputs":{"receiver_inputs":[{"txin":{"previous_output":
 * "<txid>:<vout>",...},...}],"payjoin_psbt":{...}}}` (`bitcoin::OutPoint`
 * serializes as a "txid:vout" string in JSON). `receiver_inputs` used to be
 * `CommittedInputs`'s entire value (a bare array, no `payjoin_psbt` sibling)
 * on the payjoin version this once shipped against — payjoin-1.0.0-rc.8
 * wraps it in an object instead.
 *
 * Accepts the in-memory event array from `ReceiverPersister.load()`. Returns
 * the outpoints of the committed inputs from the most recent event, or
 * undefined if inputs were never committed. The current flow contributes
 * exactly one receiver input, but all are returned so a future multi-input
 * flow fails loudly in the caller rather than silently dropping locks.
 */
export function extractCommittedInputs(events: unknown[]): { txid: string; vout: number }[] | undefined {
  if (!Array.isArray(events)) return undefined;

  let committed: { txid: string; vout: number }[] | undefined;
  for (const ev of events) {
    let parsed: unknown;
    try { parsed = typeof ev === 'string' ? JSON.parse(ev) : ev; } catch { continue; }
    const inputs = (parsed as { CommittedInputs?: { receiver_inputs?: Array<{ txin?: { previous_output?: string } }> } })
      ?.CommittedInputs?.receiver_inputs;
    if (!Array.isArray(inputs)) continue;

    const outpoints: { txid: string; vout: number }[] = [];
    for (const input of inputs) {
      const prevout = input?.txin?.previous_output;
      if (typeof prevout !== 'string') return undefined; // unexpected shape — fail loudly upstream
      const sep = prevout.lastIndexOf(':');
      const txid = prevout.slice(0, sep);
      const vout = Number(prevout.slice(sep + 1));
      if (sep <= 0 || !/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(vout) || vout < 0) return undefined;
      outpoints.push({ txid, vout });
    }
    committed = outpoints;
  }
  return committed;
}

/**
 * Whether the session event log records that the payjoin proposal was posted
 * to the directory. Once posted, the sender may hold a broadcastable payjoin
 * tx, so the receiver's contributed input must stay reserved until an on-chain
 * outcome confirms. Events are JSON-encoded strings, so a quoted-name search
 * is reliable regardless of escaping depth.
 */
export function sessionHasPostedProposal(sessionJson: string | null | undefined): boolean {
  return !!sessionJson && sessionJson.includes('PostedPayjoinProposal');
}

export async function createReceiver({ id, address, amount }: { id: number | string, address: string, amount: bigint }): Promise<{ bip21: string; ohttpRelay: string }> {
  logger.info(createReceiver, `Creating receiver for address: ${address} amount: ${amount}`);

  const { keys: ohttpKeys, relay: ohttpRelay, directory } = await getOhttpKeys();

  const persister = new ReceiverPersister({ id, db });

  const receiver = new payjoin.ReceiverBuilder(address, directory, ohttpKeys)
    .withAmount(amount)
    .withExpiration(config.PAYJOIN_RECEIVE_EXPIRY)
    .build()
    .save(persister);


  if (!receiver) {
    throw new Error('Receiver initialization failed');
  }

  const bip21 = receiver.pjUri().asString();

  return { bip21, ohttpRelay };
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

  // Set nLockTime explicitly to the current block height to match the bdk-based
  // mobile wallet, which always uses the exact chain tip for anti-fee-sniping.
  const { error: chainInfoError, result: chainInfoResult } = await cnClient.getblockchaininfo();
  if (chainInfoError || !chainInfoResult) {
    throw new Error(`Failed to get blockchain info: ${chainInfoError}`);
  }
  const locktime = chainInfoResult.blocks;

  const { error: psbtError, result: psbtResult } = await cnClient.createFundedPsbt({
    inputs: [],
    outputs: {
      [address]: Utils.satsToBtc(amount),
    },
    locktime,
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

  // record what lockUnspents:true just locked, before anything else here can throw
  const { error: decodeError, result: decodeResult } = await cnClient.decodePsbt({ psbt: psbtResult.psbt });
  if (decodeError || !decodeResult) {
    throw new Error(`Failed to decode funded psbt: ${decodeError}`);
  }
  const lockedInputs = decodeResult.tx.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout }));
  await db.send.update({ where: { id: Number(id) }, data: { lockedInputs } });

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

  // Record the signed original ("fallback") tx so the grace-expiry sweep can
  // broadcast it itself when the receiver never does. Best-effort: the sweep
  // re-derives it from the SDK session history if this is missing, so a
  // failure here must not abort a send that is otherwise ready to go.
  const { error: extractError, result: extractResult } = await cnClient.finalizePsbt({
    psbt,
    extract: true,
    wallet: config.SEND_WALLET,
  });
  if (extractError || !extractResult?.hex) {
    logger.warn(createSender, 'failed to extract fallback tx hex — will re-derive from session history if needed:', extractError);
  } else {
    await db.send.update({ where: { id: Number(id) }, data: { fallbackTxHex: extractResult.hex } });
  }

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
  } else if (receive.txid && receive.firstSeenTs) {
    // txid alone is only the posted proposal (issue #6) — report unconfirmed
    // once the tx has actually been observed on the network
    status = ReceiveStatus.Unconfirmed;
  } else if (!receive.firstSeenTs && !receive.confirmedTs && receive.expiryTs && receive.expiryTs < new Date()) {
    status = ReceiveStatus.Expired;
  }

  return {
    ...Utils.omit(receive, ['session', 'reservedInputTxid', 'reservedInputVout', 'callbackToken']),
    status
  } as IRespReceive;
}

// we stop attempting the payjoin at our own cutoff, since the receiver's BIP21 expiry is often 24h+
export function sendPayjoinDeadline(send: Pick<Send, 'createdTs' | 'expiryTs'>): Date {
  const cutoff = new Date(send.createdTs.getTime() + config.SEND_PAYJOIN_CUTOFF * 1000);
  if (!send.expiryTs) return cutoff;
  return send.expiryTs < cutoff ? send.expiryTs : cutoff;
}

export function appendSendStatus(send: Send) {
  let status = SendStatus.Pending;
  if (send.cancelledTs) {
    status = SendStatus.Cancelled;
  } else if (send.confirmedTs) {
    status = SendStatus.Confirmed;
  } else if (send.fallbackTs) {
    status = SendStatus.Fallback;
  } else if (send.txid) {
    status = SendStatus.Unconfirmed;
  } else if (!send.txid && !send.confirmedTs && sendPayjoinDeadline(send) < new Date()) {
    status = SendStatus.Expired;
  }

  return {
    ...Utils.omit(send, ['session', 'callbackToken', 'fallbackTxHex']),
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
