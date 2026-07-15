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

const recentRelayFailures = new Map<string, number>();
const RELAY_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export function recordRelayFailure(relay: string): void {
  recentRelayFailures.set(relay, Date.now());
}

function relayIsAvailable(relay: string): boolean {
  const lastFailure = recentRelayFailures.get(relay);
  if (!lastFailure) return true;
  return Date.now() - lastFailure > RELAY_FAILURE_COOLDOWN_MS;
}

/** Fisher-Yates shuffle (returns a new array) — randomizes initial relay choice to avoid a deterministic fingerprint. */
function shuffled<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick a random relay — used as a fallback when a session has no pinned relay yet. */
export function randomRelay(): string {
  return config.OHTTP_RELAYS[Math.floor(Math.random() * config.OHTTP_RELAYS.length)];
}

export async function withRelayFallback<T>(fn: (relay: string) => Promise<T>): Promise<{ result: T; relay: string }> {
  // Randomize order, then float recently-failed relays to the back (stable sort preserves the shuffle within each bucket).
  const sortedRelays = shuffled(config.OHTTP_RELAYS).sort((a, b) => {
    return (relayIsAvailable(a) ? 0 : 1) - (relayIsAvailable(b) ? 0 : 1);
  });
  let lastError: unknown;
  for (const relay of sortedRelays) {
    try {
      const result = await fn(relay);
      return { result, relay };
    } catch (e) {
      logger.warn(withRelayFallback, `Relay ${relay} failed, trying next:`, e);
      lastError = e;
    }
  }
  throw lastError;
}

async function fetchOhttpKeys(
  ohttpRelay: string,
  payjoinDirectory: string
): Promise<Uint8Array> {
  const ohttpKeysUrl = new URL(payjoinDirectory).origin + '/.well-known/ohttp-gateway';
  const proxyAgent = new HttpsProxyAgent(ohttpRelay);
  const response: AxiosResponse = await axios.get(ohttpKeysUrl, {
    httpsAgent: proxyAgent,
    timeout: config.OHTTP_RELAY_TIMEOUT_MS,
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
  logger.debug(getOhttpKeys, 'Fetching OHTTP keys from relays:', config.OHTTP_RELAYS, 'and directory:', config.PAYJOIN_DIRECTORY);
  const { result: ohttpKeysBuffer, relay } = await withRelayFallback((relay) =>
    fetchOhttpKeys(relay, config.PAYJOIN_DIRECTORY)
  );
  logger.debug(getOhttpKeys, 'Fetched OHTTP keys successfully via relay:', relay);
  return { keys: payjoin.OhttpKeys.decode(ohttpKeysBuffer.buffer as ArrayBuffer), relay };
}

export async function fetchBufferResponse(request: { url: string, contentType: string, body: any }, timeoutMs: number = config.OHTTP_RELAY_TIMEOUT_MS): Promise<ArrayBuffer> {
    const axiosResponse = await axios.post(request.url, request.body, {
        headers: { "Content-Type": request.contentType },
        responseType: 'arraybuffer',
        timeout: timeoutMs,
    });
    return axiosResponse.data;
}

export function arrayBufferToHex(buffer: ArrayBuffer): string {
    const byteArray = new Uint8Array(buffer);
    const hexCodes = [...byteArray].map(value => value.toString(16).padStart(2, '0'));
    return hexCodes.join('');
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
 * shaped like `{"CommittedInputs":[{"txin":{"previous_output":"<txid>:<vout>",...},...}]}`
 * (`bitcoin::OutPoint` serializes as a "txid:vout" string in JSON).
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
    const inputs = (parsed as { CommittedInputs?: Array<{ txin?: { previous_output?: string } }> })?.CommittedInputs;
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

  const { keys: ohttpKeys, relay: ohttpRelay } = await getOhttpKeys();

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
    // reservedInput* is internal wallet-reservation bookkeeping (issue #8) —
    // never expose wallet outpoints through the API or callbacks
    ...Utils.omit(receive, ['session', 'reservedInputTxid', 'reservedInputVout']),
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
