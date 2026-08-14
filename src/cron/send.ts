import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Prisma, Send } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { arrayBufferToHex, extractFeeFromPsbt, fetchBufferResponse, randomRelay, withRelayFallback } from "../lib/payjoin";
import { SenderPersister } from "../lib/persister";
import { FallbackOutcome } from "../types/payjoin";
import { AxiosError } from "axios";

export async function restoreSendSessions(config: Config) {
  logger.info(restoreSendSessions, 'restoring send sessions');

  const { replicaId, totalReplicas } = Utils.replicaInfo();

  const allSessions = await db.send.findMany({
    where: {
      confirmedTs: null,
      cancelledTs: null,
      expiryTs: {
        gt: new Date()
      },
      session: { not: null },
    }
  });
  const sessions = allSessions.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });
  logger.info(restoreSendSessions, `found ${sessions.length} sessions to restore`);

  await Promise.all(
    sessions.map(sendSess => processSendSession(sendSess, config))
  );

  await sweepTerminalSends(config);
}

export async function processSendSession(sendSess: Send, config: Config) {
  await lock.acquire([sendSess.id.toString(), sendSess.address!], async () => {
    logger.info(processSendSession, 'restoring session:', sendSess.id);

    if (sendSess.txid) {
      logger.info(processSendSession, 'session already has txid:', sendSess.txid);
      return;
    }

    try {
      const persister = new SenderPersister({ id: sendSess.id, db });
      persister.restore(JSON.parse(sendSess.session!));

      const replayResult = payjoin.replaySenderEventLog(persister);
      const sessionState = replayResult.state();

      if (payjoin.SendSession.WithReplyKey.instanceOf(sessionState)) {
        logger.debug(processSendSession, 'Sender is in WithReplyKey state — sending initial V2 post');

        const sender = sessionState.inner.inner;
        const { result: { responseBuffer, ohttpCtx }, relay } = await withRelayFallback(async (relay) => {
          const { request, ohttpCtx } = sender.createV2PostRequest(relay);
          const responseBuffer = await fetchBufferResponse(request);
          return { responseBuffer, ohttpCtx };
        });
        sender.processResponse(responseBuffer, ohttpCtx).save(persister);

        await db.send.update({ where: { id: sendSess.id }, data: { ohttpRelay: relay } });

        logger.info(processSendSession, 'Initial V2 post complete — session advanced to PollingForProposal');
        return;
      }

      if (payjoin.SendSession.PollingForProposal.instanceOf(sessionState)) {
        logger.debug(processSendSession, 'Sender is in PollingForProposal state — polling for proposal');

        const sender = sessionState.inner.inner;
        const { request, ohttpCtx } = sender.createPollRequest(sendSess.ohttpRelay ?? randomRelay());
        let responseBuffer: ArrayBuffer;
        try {
          responseBuffer = await fetchBufferResponse(request, config.OHTTP_LONGPOLL_TIMEOUT_MS);
        } catch (e) {
          // The directory long-polls (~30s) waiting for a payjoin proposal.
          // Our client timeout fires first (ECONNABORTED). Treat as Stasis.
          if (e instanceof AxiosError && e.code === 'ECONNABORTED') {
            logger.info(processSendSession, `poll long-poll timed out — no payjoin proposal yet, retrying next cycle (session ${sendSess.id})`);
            return;
          }
          throw e;
        }
        const outcome = sender.processResponse(responseBuffer, ohttpCtx).save(persister);

        if (payjoin.PollingForProposalTransitionOutcome.Stasis.instanceOf(outcome)) {
          logger.info(processSendSession, 'No proposal received yet — will try again next poll');
          return;
        }

        if (!payjoin.PollingForProposalTransitionOutcome.Progress.instanceOf(outcome)) {
          logger.error(processSendSession, 'Unexpected PollingForProposal outcome:', outcome);
          return;
        }

        logger.debug(processSendSession, 'Received proposal PSBT');
        const psbtBase64 = outcome.inner.psbtBase64;

        await validateAndBroadcastPayjoinPsbt(psbtBase64, sendSess, config);

        return;
      }

      logger.info(processSendSession, 'Session is in terminal state (Closed), skipping:', sessionState.tag);

    } catch (e) {
      logger.error(processSendSession, 'failed to restore session:', e);
    }
  });
}

export async function validateAndBroadcastPayjoinPsbt(
  psbtBase64: string,
  sendSess: Pick<Send, 'id' | 'amount'>,
  config: Config,
): Promise<void> {
  // Decode the proposal PSBT before signing so we can gate on fee rate.
  // The same decoded result is reused for post-broadcast accounting.
  const { error: decodeError, result: decodedProposal } = await cnClient.decodePsbt({ psbt: psbtBase64 });
  if (decodeError || !decodedProposal) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'failed to decode proposal psbt:', decodeError);
    return;
  }

  const proposedFeeRate = decodedProposal.tx.vsize > 0
    ? Number(extractFeeFromPsbt(decodedProposal)) / decodedProposal.tx.vsize
    : 0;
  logger.info(validateAndBroadcastPayjoinPsbt, 'proposal fee rate (sat/vbyte):', proposedFeeRate);

  if (proposedFeeRate > config.MAX_PAYJOIN_FEE_RATE) {
    logger.error(
      validateAndBroadcastPayjoinPsbt,
      `proposal fee rate ${proposedFeeRate.toFixed(1)} sat/vbyte exceeds MAX_PAYJOIN_FEE_RATE ` +
      `${config.MAX_PAYJOIN_FEE_RATE} sat/vbyte — refusing to sign`,
    );
    return;
  }

  const { error: processedError, result: processedResult } = await cnClient.processPsbt({
    psbt: psbtBase64,
    finalize: true,
    sign: true,
    wallet: config.SEND_WALLET,
  });

  if (processedError || !processedResult) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'failed to process psbt:', processedError);
    return;
  }

  if (!processedResult.complete) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'payjoin proposal PSBT could not be fully signed', processedResult);
    return;
  }

  const { error: finalizeError, result: finalizeResult } = await cnClient.finalizePsbt({
    psbt: processedResult.psbt,
    extract: true,
    wallet: config.SEND_WALLET,
  });

  if (finalizeError || !finalizeResult) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'failed to finalize psbt:', finalizeError);
    return;
  }

  if (!finalizeResult.hex) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'failed to extract transaction hex:', finalizeResult);
    return;
  }

  const { error: sendError, result: sendResult } = await cnClient.sendRawTransaction({
    hex: finalizeResult.hex,
    wallet: config.SEND_WALLET,
  });

  if (sendError) {
    logger.error(validateAndBroadcastPayjoinPsbt, 'failed to send transaction:', sendError);
    return;
  }

  // Reuse the pre-sign decode result for fee accounting — input/output amounts
  // and addresses are identical between the proposal and the signed PSBT.
  const totalFee = extractFeeFromPsbt(decodedProposal);
  logger.debug(validateAndBroadcastPayjoinPsbt, 'total fee:', totalFee);

  const txInputs = decodedProposal.inputs.map((input) => {
    const address = input.witness_utxo?.scriptPubKey?.address ?? null;
    const amount = Utils.btcToSats(input.witness_utxo?.amount || 0);
    const ownedBy: 'sender' | 'receiver' | null =
      address ? (isAddressOwned(address, config) ? 'sender' : 'receiver') : null;
    return { address, amount: amount.toString(), ownedBy };
  });

  const txOutputs = decodedProposal.tx.vout.map((output) => {
    const address = output.scriptPubKey?.address ?? null;
    const amount = Utils.btcToSats(output.value || 0);
    const ownedBy: 'sender' | 'receiver' | null =
      address ? (isAddressOwned(address, config) ? 'sender' : 'receiver') : null;
    return { address, amount: amount.toString(), ownedBy };
  });

  const senderTotalInputAmount = txInputs
    .filter(i => i.ownedBy === 'sender')
    .reduce((acc, i) => acc + BigInt(i.amount), 0n);
  logger.debug(validateAndBroadcastPayjoinPsbt, 'total sender input amount:', senderTotalInputAmount);

  const senderTotalOutputAmount = txOutputs
    .filter(o => o.ownedBy === 'sender')
    .reduce((acc, o) => acc + BigInt(o.amount), 0n);
  logger.debug(validateAndBroadcastPayjoinPsbt, 'total sender output amount:', senderTotalOutputAmount);

  const receiverTotalInputAmount = txInputs
    .filter(i => i.ownedBy === 'receiver')
    .reduce((acc, i) => acc + BigInt(i.amount), 0n);
  logger.debug(validateAndBroadcastPayjoinPsbt, 'total receiver input amount:', receiverTotalInputAmount);

  const receiverTotalOutputAmount = txOutputs
    .filter(o => o.ownedBy === 'receiver')
    .reduce((acc, o) => acc + BigInt(o.amount), 0n);
  logger.debug(validateAndBroadcastPayjoinPsbt, 'total receiver output amount:', receiverTotalOutputAmount);

  const rawFee = senderTotalInputAmount - senderTotalOutputAmount - sendSess.amount;
  const senderFee = rawFee >= 0n ? rawFee : 0n;
  if (rawFee < 0n) {
    logger.warn(validateAndBroadcastPayjoinPsbt, 'sender fee calculation produced negative value — address ownership may be misclassified:', rawFee);
  }
  logger.debug(validateAndBroadcastPayjoinPsbt, 'sender fee:', senderFee);

  if (sendResult) {
    const updateResult = await db.send.update({
      where: { id: Number(sendSess.id) },
      data: {
        txid: sendResult,
        fee: totalFee,
        senderFee,
        senderInAmount: senderTotalInputAmount,
        senderOutAmount: senderTotalOutputAmount,
        receiverInAmount: receiverTotalInputAmount,
        receiverOutAmount: receiverTotalOutputAmount,
        txInputs,
        txOutputs,
      },
    });
    logger.info(validateAndBroadcastPayjoinPsbt, 'updated session with txid:', sendResult, updateResult);
  } else {
    logger.error(validateAndBroadcastPayjoinPsbt, 'broadcast succeeded but no txid returned');
  }
}

function isAddressOwned(address: string, config: Config): boolean {
  logger.debug(isAddressOwned, 'checking if address is owned:', address);

  const { error: addressError, result: addressResult } = syncCnClient.syncGetAddressInfo({
    address,
    wallet: config.SEND_WALLET,
  });
  if (addressError || !addressResult) {
    logger.error(isAddressOwned, 'failed to get address info:', addressError);
    return false;
  }

  if (addressResult.ismine) {
    logger.debug(isAddressOwned, 'address is owned by sender wallet:', address);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Terminal-send sweep: give locked inputs back, and rescue the payment the
// receiver was supposed to broadcast.
//
// createSender() funds and signs the sender's original ("fallback") tx with
// lockUnspents:true and hands it to the receiver, who is supposed to broadcast
// it when the payjoin fails. Receiver wallets do not reliably do that, so
// releasing the locks without checking silently drops the payment.
// ---------------------------------------------------------------------------

/**
 * Resolve every terminal send still holding inputs from createSender().
 *
 * Expiry alone gets RESERVATION_RELEASE_GRACE first: the original may still be
 * a counterparty's fallback tx in flight. Cancellation releases immediately.
 */
export async function sweepTerminalSends(config: Config) {
  const { replicaId, totalReplicas } = Utils.replicaInfo();

  // Rows that already carry a txid are included on purpose: the watch callback
  // records whatever lands without knowing whether it was the payjoin or the
  // receiver finally broadcasting our original, so those rows still need their
  // lock bookkeeping settled — and labelling, if the tx turns out to be ours.
  const graceExpiredBefore = new Date(Date.now() - config.RESERVATION_RELEASE_GRACE * 1000);
  const allStuckSends = await db.send.findMany({
    where: {
      lockedInputs: { not: Prisma.DbNull },
      OR: [{ cancelledTs: { not: null } }, { expiryTs: { lte: graceExpiredBefore } }],
    },
  });
  // shard like every other sweep — processTerminalSend can now broadcast, so
  // two replicas racing the same row is no longer merely wasteful
  const stuckSends = allStuckSends.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });

  if (stuckSends.length === 0) return;

  logger.info(sweepTerminalSends, `found ${stuckSends.length} terminal send(s) with locked inputs to resolve`);
  await Promise.all(
    stuckSends.map(sendSess => processTerminalSend(sendSess, config))
  );
}

/**
 * Resolve one terminal send: release its locked inputs, and — for sends that
 * reached expiry rather than being cancelled — first broadcast the sender's
 * original if nothing spending those inputs ever reached the network.
 *
 * A cancelled send is never broadcast: the user asked for the payment not to
 * happen, so its inputs are simply released.
 */
export async function processTerminalSend(sendSess: Send, config: Config) {
  // lock on id and address like processSendSession — a send whose address is
  // still null never reached createSender, so id alone is the whole key
  const keys = [sendSess.id.toString(), sendSess.address].filter((k): k is string => !!k);
  await lock.acquire(keys, async () => {
    // re-read under the lock: an address callback or a racing cron tick may
    // have recorded an outcome between the sweep query and here
    const fresh = await db.send.findUnique({ where: { id: sendSess.id } });
    if (!fresh) return;

    const utxos = fresh.lockedInputs as unknown as { txid: string; vout: number }[] | null;
    if (!Array.isArray(utxos) || utxos.length === 0) return;

    // Something already landed — our payjoin, or the receiver finally
    // broadcasting our original. Either way those inputs are spent, so the
    // lock record is moot; the only open question is which tx it was, because
    // the watch callback records a txid without knowing.
    if (fresh.txid) {
      await settleBroadcastSend(fresh);
      return;
    }

    if (fresh.cancelledTs) {
      logger.info(processTerminalSend, `send ${fresh.id} was cancelled — releasing inputs without broadcasting`);
      await releaseLockedInputs(fresh.id, utxos, config);
      return;
    }

    const outcome = await broadcastSendFallback(fresh, config);

    // Defer keeps the locks for another tick; Broadcast means the inputs are
    // spent and lockedInputs has already been cleared alongside the txid.
    if (outcome === FallbackOutcome.Defer || outcome === FallbackOutcome.Broadcast) return;

    await releaseLockedInputs(fresh.id, utxos, config);
  });
}

/**
 * Settle the bookkeeping for a send whose tx is already on the network.
 *
 * The address watch records a txid without knowing whether it belongs to the
 * payjoin or to our original — so a fallback the RECEIVER broadcast would
 * otherwise be reported as an ordinary send. Comparing against the stored
 * original is what tells the two apart; matching it stamps fallbackTs so the
 * status reads "fallback" rather than a payjoin that never happened.
 *
 * The inputs are spent either way, so lockedInputs is cleared rather than
 * unlocked — there is nothing left to give back.
 */
async function settleBroadcastSend(sendSess: Send) {
  let isFallback = false;
  if (sendSess.fallbackTxHex && !sendSess.fallbackTs) {
    const { result } = await cnClient.decodeRawTransaction({ hex: sendSess.fallbackTxHex });
    isFallback = !!result?.tx?.txid && result.tx.txid === sendSess.txid;
  }

  logger.info(
    settleBroadcastSend,
    `send ${sendSess.id} already carries ${isFallback ? 'our original (receiver broadcast it)' : 'a tx'} ${sendSess.txid} — clearing its lock record`,
  );

  await db.send.update({
    where: { id: sendSess.id },
    data: {
      lockedInputs: Prisma.DbNull,
      ...(isFallback ? { fallbackTs: new Date() } : {}),
    },
  }).catch((e) => logger.error(settleBroadcastSend, `failed to settle send ${sendSess.id}:`, e));
}

/**
 * Ask Cyphernode whether anything spending this send's inputs is on the
 * network and, if not, broadcast the stored original ourselves.
 *
 * Two questions, because one lookup cannot answer both:
 *   1. is OUR original already out there? — a txid lookup answers that, and
 *      lets us record it;
 *   2. is ANY OTHER tx spending these inputs? — the payjoin the receiver
 *      broadcast has a txid we never learned, so there is nothing to look up.
 *      testmempoolaccept answers it without one: a conflicting mempool tx or a
 *      confirmed spend both make our original inadmissible, and it says so
 *      without touching the network.
 *
 * Never broadcasts on an ambiguous answer: as in the receive-side
 * broadcastFallback(), only a definite not-found (bitcoind -5) plus a clean
 * mempool-acceptance result lets the broadcast proceed.
 */
export async function broadcastSendFallback(sendSess: Send, config: Config): Promise<FallbackOutcome> {
  const fallbackTxHex = sendSess.fallbackTxHex ?? await recoverFallbackTxHex(sendSess);
  if (!fallbackTxHex) {
    logger.warn(broadcastSendFallback, `no fallback tx available for send ${sendSess.id} — releasing its inputs unbroadcast`);
    return FallbackOutcome.Release;
  }

  const { error: decodeError, result: decodeResult } = await cnClient.decodeRawTransaction({ hex: fallbackTxHex });
  if (decodeError || !decodeResult?.tx?.txid) {
    logger.error(broadcastSendFallback, `failed to decode fallback tx for send ${sendSess.id} — deferring:`, decodeError);
    return FallbackOutcome.Defer;
  }
  const fallbackTxid = decodeResult.tx.txid;

  // (1) /gettransaction is a getrawtransaction-style lookup (needs txindex=1),
  // so it answers for both the mempool and the chain regardless of wallet.
  const { error: lookupError, result: lookupResult } = await cnClient.getTransaction(fallbackTxid);
  if (lookupResult?.txid) {
    logger.info(broadcastSendFallback, `fallback tx ${fallbackTxid} already on the network for send ${sendSess.id} — recording it instead of rebroadcasting`);
    await recordFallbackBroadcast(sendSess.id, fallbackTxid);
    return FallbackOutcome.Broadcast;
  }
  if (lookupError?.code !== -5) {
    logger.warn(broadcastSendFallback, `fallback tx lookup failed for send ${sendSess.id} — deferring broadcast:`, lookupError);
    return FallbackOutcome.Defer;
  }

  // (2) our original is nowhere, but some other tx may already spend its inputs
  const admissibility = await checkFallbackAdmissible(sendSess.id, fallbackTxHex);
  if (admissibility === FallbackOutcome.Broadcast) {
    await recordFallbackBroadcast(sendSess.id, fallbackTxid);
    return FallbackOutcome.Broadcast;
  }
  if (admissibility !== null) return admissibility;

  logger.info(broadcastSendFallback, `no tx spending send ${sendSess.id}'s inputs — broadcasting the sender's original ${fallbackTxid}`);
  const { error: sendError, result: sendResult } = await cnClient.sendRawTransaction({
    hex: fallbackTxHex,
    wallet: config.SEND_WALLET,
  });

  if (sendError || !sendResult) {
    // the checks above are a snapshot; the network can move underneath us
    // between testmempoolaccept and here, so classify the real failure too
    const outcome = classifyBroadcastFailure(String(sendError?.message ?? ''));

    if (outcome === FallbackOutcome.Broadcast) {
      logger.warn(broadcastSendFallback, `fallback tx for send ${sendSess.id} was already broadcast — recording it`);
      await recordFallbackBroadcast(sendSess.id, fallbackTxid);
      return FallbackOutcome.Broadcast;
    }
    if (outcome === FallbackOutcome.Release) {
      logger.warn(broadcastSendFallback, `inputs of send ${sendSess.id} are already spent by a conflicting tx — releasing locks without rebroadcast:`, sendError);
      return FallbackOutcome.Release;
    }

    // anything else (fee policy, transient RPC failure) may clear on its own
    logger.error(broadcastSendFallback, `failed to broadcast fallback tx for send ${sendSess.id} — retrying next cycle:`, sendError);
    return FallbackOutcome.Defer;
  }

  logger.info(broadcastSendFallback, `broadcast fallback tx for send ${sendSess.id}:`, sendResult);
  await recordFallbackBroadcast(sendSess.id, sendResult);
  return FallbackOutcome.Broadcast;
}

/**
 * Dry-run the original against the mempool to catch a tx we have no txid for —
 * typically the payjoin the receiver broadcast before our record caught up.
 *
 * Returns null when the original is admissible (nothing else spends its
 * inputs), otherwise the outcome that settles the send. The conflicting tx's
 * own txid is not knowable here; the address watch records it when it fires.
 */
async function checkFallbackAdmissible(id: number, fallbackTxHex: string): Promise<FallbackOutcome | null> {
  const { error, result } = await cnClient.testMempoolAccept({ rawtx: fallbackTxHex });
  const verdict = result?.[0];
  if (error || !verdict) {
    logger.warn(checkFallbackAdmissible, `mempool-acceptance test failed for send ${id} — deferring broadcast:`, error);
    return FallbackOutcome.Defer;
  }

  if (verdict.allowed) return null;

  const reason = String(verdict['reject-reason'] ?? '');
  const outcome = classifyBroadcastFailure(reason);

  if (outcome === FallbackOutcome.Broadcast) {
    logger.info(checkFallbackAdmissible, `fallback tx for send ${id} is already known to the node (${reason}) — recording it rather than rebroadcasting`);
    return FallbackOutcome.Broadcast;
  }
  if (outcome === FallbackOutcome.Release) {
    logger.warn(checkFallbackAdmissible, `another tx already spends send ${id}'s inputs (${reason}) — releasing locks without broadcasting`);
    return FallbackOutcome.Release;
  }

  logger.warn(checkFallbackAdmissible, `fallback tx for send ${id} is not currently acceptable (${reason}) — deferring broadcast`);
  return FallbackOutcome.Defer;
}

/**
 * Map a bitcoind rejection (from sendrawtransaction or testmempoolaccept) onto
 * what it means for the send's inputs.
 *
 *   Broadcast — this exact tx is already out there; the payment exists
 *   Release   — some other tx spends these inputs; ours can never confirm
 *   Defer     — fee policy or a transient failure that may clear on its own
 *
 * "insufficient fee" belongs with the conflicts, not with the fee failures it
 * reads like. Bitcoin Core uses it only on the replacement path — it is
 * reached when a conflicting tx already holds these inputs and ours does not
 * outbid it, which our original, signed long ago at the fee rate of the day,
 * never will. A genuinely underpaying tx is rejected as "min relay fee not
 * met" / "mempool min fee not met" instead, and those stay deferrable.
 * (sendrawtransaction spells the replacement case out as "insufficient fee,
 * rejecting replacement …"; testmempoolaccept reports the short code alone.)
 * Deferring on it leaves the send retrying a doomed broadcast forever.
 */
function classifyBroadcastFailure(message: string): FallbackOutcome {
  if (/already in block ?chain|txn-already-known|already known|outputs already in utxo set|txn-already-in-mempool/i.test(message)) {
    return FallbackOutcome.Broadcast;
  }
  if (/missingorspent|missing inputs|missing-inputs|txn-mempool-conflict|conflict|rejecting replacement|insufficient fee/i.test(message)) {
    return FallbackOutcome.Release;
  }
  return FallbackOutcome.Defer;
}

/**
 * Re-derive the signed original from the SDK event log for rows written before
 * createSender() started storing it (or whose extraction failed there), and
 * persist it so the next cycle does not have to replay.
 */
async function recoverFallbackTxHex(sendSess: Send): Promise<string | null> {
  if (!sendSess.session) return null;

  let fallbackTxHex: string;
  try {
    const persister = new SenderPersister({ id: sendSess.id, db });
    persister.restore(JSON.parse(sendSess.session));
    const fallbackTx = payjoin.replaySenderEventLog(persister).sessionHistory().fallbackTx();
    if (!fallbackTx) return null;
    fallbackTxHex = arrayBufferToHex(fallbackTx);
  } catch (e) {
    logger.error(recoverFallbackTxHex, `failed to recover fallback tx from session history for send ${sendSess.id}:`, e);
    return null;
  }

  await db.send.update({ where: { id: sendSess.id }, data: { fallbackTxHex } })
    .catch((e) => logger.error(recoverFallbackTxHex, `failed to persist recovered fallback tx for send ${sendSess.id}:`, e));

  return fallbackTxHex;
}

/**
 * Record that this send's on-chain outcome is the plain original rather than a
 * payjoin. Clearing lockedInputs drops the row out of the sweep — the inputs
 * are spent, so Core's (non-persistent) locks on them no longer matter.
 */
async function recordFallbackBroadcast(id: number, txid: string) {
  await db.send.update({
    where: { id },
    data: { txid, fallbackTs: new Date(), lockedInputs: Prisma.DbNull },
  }).catch((e) => logger.error(recordFallbackBroadcast, `failed to record fallback broadcast for send ${id}:`, e));
}

/**
 * Give back exactly the outpoints recorded on the row — never a blanket unlock.
 *
 * An outpoint that is already gone counts as released, mirroring the
 * receive-side releaseReservedInput(). Two ordinary situations produce that:
 * a conflicting tx spent the inputs (so Core reports them no longer unspent —
 * the whole Release path lands here), and these locks are non-persistent, so a
 * bitcoind restart drops them. Treating either as a failure would retry a
 * lock that can never be taken again and strand the row forever.
 */
async function releaseLockedInputs(id: number, utxos: { txid: string; vout: number }[], config: Config) {
  const { error, result } = await cnClient.lockUnspent({ unlock: true, utxos, wallet: config.SEND_WALLET });

  const released = (!error && result?.success === true)
    || /expected unspent output|expected locked output|unknown transaction|vout index out of bounds/i.test(String(error?.message ?? ''));
  if (!released) {
    logger.error(releaseLockedInputs, `failed to release locked inputs for send ${id} — retrying next cycle:`, error ?? result);
    return;
  }

  await db.send.update({ where: { id }, data: { lockedInputs: Prisma.DbNull } });
  logger.info(releaseLockedInputs, `released ${utxos.length} locked input(s) for terminal send ${id}`);
}
