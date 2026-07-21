import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Receive } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { AxiosError } from "axios";
import { arrayBufferToHex, describePayjoinError, extractCommittedInputs, extractFeeFromPsbt, extractReplyableError, fetchBufferResponse, randomRelay, recordRelayFailure, sessionHasPostedProposal } from "../lib/payjoin";
import { addressCallbackUrl } from "../api/callback/address";
import { ReceiverPersister } from "../lib/persister";
import { claimSeenInputsForSession, outpointKey, SeenInputConflictError, SeenOutpoint } from "../lib/seenInputs";

  interface InputPairWithMetadata {
    inputPair: payjoin.InputPair;
    txid: string;
    vout: number;
    amount: number | string;
    scriptPubKey: string;
  }

export async function restoreReceiveSessions(config: Config) {
  logger.info(restoreReceiveSessions, 'restoring receive sessions');

  const { replicaId, totalReplicas } = Utils.replicaInfo();

  // attempt to process all "current" receive sessions
  const allSessions = await db.receive.findMany({
    where: {
      bip21: { not: null },
      txid: null,
      confirmedTs: null,
      cancelledTs: null,
      expiryTs: {
        gt: new Date()
      },
      session: { not: null }
    }
  });
  const sessions = allSessions.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });
  logger.info(restoreReceiveSessions, `found ${sessions.length} sessions to restore`);

  await Promise.all(
    sessions.map(receiveSess => processReceiveSession(receiveSess, config))
  );

  // attempt to broadcast any fallback txs that payjoin failed but fallback has not been broadcast
  const allFailedSessions = await db.receive.findMany({
    where: {
      confirmedTs: null,
      cancelledTs: null,
      failedTs: {
        lte: new Date(Date.now() - 2 * 60 * 1000) // Current date minus 2 minutes
      },
      fallbackTxHex: { not: null },
      fallbackAbandonedTs: null,
      txid: null,
    }
  });
  const failedSessions = allFailedSessions.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });
  logger.info(restoreReceiveSessions, `found ${failedSessions.length} failed sessions to broadcast`);
  await Promise.all(
    failedSessions.map(receiveSess => broadcastFallback(receiveSess, config))
  );

  // Recover payment from posted-but-abandoned sessions (issue #8): the sender
  // fetched our proposal but never broadcast anything and the session has
  // expired. Broadcast the stored fallback (the sender's signed original tx) —
  // it claims the payment and, once confirmed, is the on-chain outcome that
  // lets releaseReservedInput free the reserved input through its normal
  // posted/confirmed rules. firstSeenTs null keeps us from racing a payjoin
  // or fallback tx that is already in the mempool.
  const allAbandonedPosted = await db.receive.findMany({
    where: {
      session: { contains: 'PostedPayjoinProposal' },
      confirmedTs: null,
      cancelledTs: null,
      fallbackTs: null,
      nonPayjoinTs: null,
      firstSeenTs: null,
      fallbackAbandonedTs: null,
      fallbackTxHex: { not: null },
      expiryTs: { lte: new Date() },
    }
  });
  const abandonedPosted = allAbandonedPosted.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });
  if (abandonedPosted.length > 0) {
    logger.info(restoreReceiveSessions, `found ${abandonedPosted.length} expired posted sessions with no outcome — broadcasting fallback`);
    await Promise.all(
      abandonedPosted.map(receiveSess => broadcastFallback(receiveSess, config))
    );
  }

  // release receiver-input reservations held by sessions that reached a
  // terminal state (issue #8) — releaseReservedInput applies the
  // posted/confirmed safety rules per row
  const allTerminalReserved = await db.receive.findMany({
    where: {
      reservedInputTxid: { not: null },
      OR: [
        { confirmedTs: { not: null } },
        { cancelledTs: { not: null } },
        { fallbackAbandonedTs: { not: null } },
        { expiryTs: { lte: new Date() } },
      ],
    }
  });
  const terminalReserved = allTerminalReserved.filter(session => {
    return session.id % totalReplicas === (replicaId - 1);
  });
  if (terminalReserved.length > 0) {
    logger.info(restoreReceiveSessions, `found ${terminalReserved.length} terminal sessions with reserved inputs to release`);
    await Promise.all(
      terminalReserved.map(receiveSess => releaseReservedInput(receiveSess, config))
    );
  }
}

async function processReceiveSession(receiveSess: Receive, config: Config) {
  // lock on both id and address - cancel uses id, watch uses address
  await lock.acquire([receiveSess.id.toString(), receiveSess.address!], async () => {
    logger.info(processReceiveSession, 'restoring session:', receiveSess.id);

    if (receiveSess.txid) {
      // Defensive only: the restore query filters txid: null, so this just
      // catches a callback setting txid between query and lock. Posted
      // sessions whose payjoin never lands are handled by the abandoned-posted
      // sweep in restoreReceiveSessions, which broadcasts the fallback after
      // expiry (formerly a @todo here).
      logger.info(processReceiveSession, 'session already has txid:', receiveSess.txid);
      return;
    }

    try {
      const persister = new ReceiverPersister({ id: receiveSess.id, db });
      persister.restore(JSON.parse(receiveSess.session || '[]'));
      const replayResult = payjoin.replayReceiverEventLog(persister);

      // capture before any output substitution may update receiveSess.address
      const originalReceiverAddress = receiveSess.address;
      // amount the sender is paying us in the original (fallback) tx — set in OutputsUnknown
      let senderPaymentAmount = 0n;

      const restoredReceiver = replayResult.state();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let receiver: any = restoredReceiver.inner.inner;

      logger.debug(processReceiveSession, 'restored receiver state:', restoredReceiver.tag);

      // Terminal state — the session has already been closed (payjoin completed, or the
      // error reply below ran). The on-chain outcome is tracked by the address watch
      // callback and broadcastFallback(); re-running the flow would only waste a cron
      // cycle, so skip. (Closed carries an outcome object, not a receiver state.)
      if (restoredReceiver.tag === 'Closed') {
        logger.info(processReceiveSession, 'Receiver session is Closed — skipping');
        return;
      }

      // A prior pass recorded a replyable error (e.g. the original PSBT was rejected as
      // un-broadcastable). The protocol expects us to return that error to the sender so
      // it stops waiting and broadcasts its own fallback. Deliver the error response, which
      // also transitions the session to its terminal Closed state so it isn't replayed
      // every cycle. The fallback tx itself is broadcast separately by broadcastFallback()
      // using the stored fallbackTxHex.
      if (receiver instanceof payjoin.HasReplyableError) {
        logger.info(processReceiveSession, 'Receiver is in HasReplyableError state — returning error response to sender');

        const errReq = receiver.createErrorRequest(receiveSess.ohttpRelay ?? randomRelay());
        let errResponseBuffer: ArrayBuffer;
        try {
          errResponseBuffer = await fetchBufferResponse(errReq.request);
        } catch (e) {
          // Same long-poll/timeout semantics as the proposal poll: a transient relay
          // timeout isn't a hard failure — retry on the next cron cycle.
          if (e instanceof AxiosError && e.code === 'ECONNABORTED') {
            logger.info(processReceiveSession, `error-reply post timed out — retrying next cycle (session ${receiveSess.id})`);
            return;
          }
          throw e;
        }

        // save() persists the response acknowledgement and closes the session.
        receiver.processErrorResponse(errResponseBuffer, errReq.clientResponse).save(persister);
        await persister.flush();
        logger.info(processReceiveSession, 'error response delivered to sender; session closed');

        // Record the actual protocol error pulled from the persisted GotReplyableError event
        // (e.g. "OriginalPsbtRejected: Can't broadcast. PSBT rejected by mempool.") rather
        // than a generic string. Preserve any existing failedTs so broadcastFallback's
        // timer isn't reset.
        const failedReason = extractReplyableError(receiveSess.session) ?? 'payjoin rejected by receiver';
        await db.receive.update({
          where: { id: receiveSess.id },
          data: { failedReason, failedTs: receiveSess.failedTs ?? new Date() },
        }).catch((err) => logger.error(processReceiveSession, 'failed to record HasReplyableError reason:', err));

        return;
      }

      if (receiver instanceof payjoin.Initialized) {
        logger.debug(processReceiveSession, 'Receiver is in Initialized state');

        const rr = receiver.createPollRequest(receiveSess.ohttpRelay ?? randomRelay());
        let responseBuffer: ArrayBuffer;
        try {
          responseBuffer = await fetchBufferResponse(rr.request, config.OHTTP_LONGPOLL_TIMEOUT_MS);
        } catch (e) {
          // The directory uses a long-poll (~30s) waiting for a sender's proposal.
          // Our client timeout fires first, producing ECONNABORTED. This is not a
          // relay failure — it means no sender has appeared yet. Treat it as Stasis
          // and let the next cron cycle retry rather than stamping failedTs.
          if (e instanceof AxiosError && e.code === 'ECONNABORTED') {
            logger.info(processReceiveSession, `poll long-poll timed out — no sender proposal yet, retrying next cycle (session ${receiveSess.id})`);
            return;
          }
          throw e;
        }

        logger.debug(processReceiveSession, 'fetched poll response. About to processResponse');
        const result = receiver.processResponse(responseBuffer, rr.clientResponse).save(persister);
        logger.debug(processReceiveSession, 'processed poll response');
        if (!result || result instanceof payjoin.InitializedTransitionOutcome.Stasis) {
          logger.info(processReceiveSession, 'no proposal found yet');
          return;
        } else if (result instanceof payjoin.InitializedTransitionOutcome.Progress) {
          logger.debug(processReceiveSession, 'Receiver is in Progress state');
          receiver = result.inner.inner;
        } else {
          logger.error(processReceiveSession, 'Unexpected Initialized Transition Outcome', result);
          return;
        }
      }

      const { error: minFeeError, result: minFeeResult } = await cnClient.getFeeRate({
        confTarget: 6,
      });
      if (minFeeError) {
        logger.error(processReceiveSession, 'failed to get fee rate:', minFeeError);
        return;
      }
      logger.info(processReceiveSession, 'min fee rate:', minFeeResult?.feerate);

      if (receiver instanceof payjoin.UncheckedOriginalPayload) {
        logger.debug(processReceiveSession, 'Receiver is in UncheckedOriginalPayload state');

        receiver = receiver.checkBroadcastSuitability(
            BigInt(minFeeResult!.feerate),
            { callback: canBroadcast },
        ).save(persister);
      }

      if (receiver instanceof payjoin.MaybeInputsOwned) {
        logger.debug(processReceiveSession, 'Receiver is in MaybeInputsOwned state');

        receiver = receiver.checkInputsNotOwned(
          { callback: (script: ArrayBuffer) => isOwned(script, config) },
        ).save(persister);

        logger.debug('checkInputsNotOwned complete');
      }
      
      if (receiver instanceof payjoin.MaybeInputsSeen) {
        logger.debug(processReceiveSession, 'Receiver is in MaybeInputsSeen state');

        const next = await checkNoInputsSeen(receiver, receiveSess.bip21!, persister, receiveSess.id);
        if (next === null) return; // transient DB failure — fail closed, retry next cycle
        receiver = next;

        logger.debug('checkNoInputsSeenBefore complete');
      }

      if (!receiveSess.fallbackTxHex) {
        logger.debug(processReceiveSession, 'no fallback tx hex found, attempting to get from session history');
        const finalReplayResult = payjoin.replayReceiverEventLog(persister);
        const sessionHistory = finalReplayResult.sessionHistory();
        const fallbackTx = sessionHistory.fallbackTx();
        logger.debug(processReceiveSession, 'got fallback tx from session history:', fallbackTx);

        if (fallbackTx) {
          logger.debug(processReceiveSession, 'got fallback tx from session history:', fallbackTx);
          const fallbackTxHex = arrayBufferToHex(fallbackTx);

          const { error: decodeError, result: decodeResult } = await cnClient.decodeRawTransaction({ hex: fallbackTxHex }); 

          if (decodeError || !decodeResult) {
            logger.error(processReceiveSession, 'failed to decode fallback tx:', decodeError);
            return;
          }
          logger.info(processReceiveSession, 'decoded fallback tx:', decodeResult);

          receiveSess = await db.receive.update({
            where: { id: receiveSess.id },
            data: {
              fallbackTxHex,
            }
          });
        } else {
          logger.warn(processReceiveSession, 'no fallback tx found in session history');
        }
      }

      if (!receiveSess.fallbackTxHex) {
        logger.info(processReceiveSession, 'no fallback tx hex found');
        return;
      }

      if (receiver instanceof payjoin.OutputsUnknown) {
        logger.debug(processReceiveSession, 'Receiver is in OutputsUnknown state');

        const { error: decodeError, result: decodeResult } = await cnClient.decodeRawTransaction({ hex: receiveSess.fallbackTxHex }); 

        if (decodeError || !decodeResult) {
          logger.error(processReceiveSession, 'failed to decode fallback tx:', decodeError);
          return;
        }
        logger.info(processReceiveSession, 'decoded fallback tx:', decodeResult);

        const receiverOutputs = decodeResult.tx.vout
          .filter(vout => vout.scriptPubKey.address === originalReceiverAddress)
          .map((vout) => {
            return [
              vout.n,
              vout.scriptPubKey.hex,
            ] as [number, string];
          });

        senderPaymentAmount = decodeResult.tx.vout
          .filter(vout => vout.scriptPubKey.address === originalReceiverAddress)
          .reduce((acc, vout) => acc + Utils.btcToSats(vout.value), 0n);
        logger.debug(processReceiveSession, 'sender payment amount from fallback tx:', senderPaymentAmount);

        const isReceiverOutput = (script: ArrayBuffer): boolean => {
          const scriptHex = arrayBufferToHex(script);
          return receiverOutputs.some((output) => output[1].toString() === scriptHex);
        }

        receiver = receiver.identifyReceiverOutputs(
          { callback: isReceiverOutput }
        )
        .save(persister);

        logger.debug('identifyReceiverOutputs complete');
      }
      
      // tracks the address actually used in the payjoin output (may differ from receiveSess.address after substitution)
      let effectiveReceiverAddress = receiveSess.address;

      if (receiver instanceof payjoin.WantsOutputs) {
        logger.debug(processReceiveSession, 'Receiver is in WantsOutputs state');

        if (config.OUTPUT_SUBSTITUTION_ENABLED && receiver.outputSubstitution() === payjoin.OutputSubstitution.Enabled) {
          // explicit bech32 to match the mobile wallet's bip84 default.
          const { error: addrError, result: addrResult } = await cnClient.getnewaddress({ addressType: "bech32", wallet: config.RECEIVE_WALLET });
          if (!addrError && addrResult?.address) {
            try {
              const { error: addrInfoError, result: addrInfoResult } = await cnClient.getAddressInfo({ address: addrResult.address, wallet: config.RECEIVE_WALLET });
              if (addrInfoError || !addrInfoResult?.scriptPubKey) {
                throw new Error(`Failed to get scriptPubKey for address: ${addrResult.address}`);
              }
              const freshScript = new Uint8Array(Buffer.from(addrInfoResult.scriptPubKey, 'hex')).buffer;
              receiver = receiver.substituteReceiverScript(freshScript).commitOutputs().save(persister);
              effectiveReceiverAddress = addrResult.address;
              logger.info(processReceiveSession, 'substituted receiver output to fresh address:', addrResult.address);

              // swap the watch from the original BIP21 address to the substituted address
              // so that the address callback fires correctly when the payjoin tx confirms
              const oldWatchUrl = addressCallbackUrl('receive', receiveSess.address!);
              await cnClient.unwatch({ address: receiveSess.address!, unconfirmedCallbackURL: oldWatchUrl, confirmedCallbackURL: oldWatchUrl });
              const newWatchUrl = addressCallbackUrl('receive', effectiveReceiverAddress);
              await cnClient.watch({ address: effectiveReceiverAddress, unconfirmedCallbackURL: newWatchUrl, confirmedCallbackURL: newWatchUrl });
              receiveSess = await db.receive.update({ where: { id: receiveSess.id }, data: { address: effectiveReceiverAddress } });
            } catch (subErr) {
              logger.warn(processReceiveSession, 'output substitution failed, committing without substitution:', subErr);
              receiver = receiver.commitOutputs().save(persister);
            }
          } else {
            logger.warn(processReceiveSession, 'could not get fresh address for substitution:', addrError);
            receiver = receiver.commitOutputs().save(persister);
          }
        } else {
          receiver = receiver.commitOutputs().save(persister);
        }

        logger.debug('commitOutputs complete');
      }

      if (receiver instanceof payjoin.WantsInputs) {
        logger.debug(processReceiveSession, 'Receiver is in WantsInputs state');

        // target the payment amount so the contributed input resembles a natural wallet-selected coin (see availableInputs)
        const inputs = await availableInputs(config, receiveSess.amount);
        logger.debug(processReceiveSession, 'selected inputs:', inputs);

        if (inputs.length === 0) {
          logger.error(processReceiveSession, 'no inputs found to contribute');
          return;
        }

        // The selected InputPair cannot be identified here: the FFI returns a
        // freshly lifted wrapper object with no outpoint accessors. The
        // committed outpoint is instead recovered from the CommittedInputs
        // session event and reserved below, before any signing.
        const inputPairs = inputs.map((input) => input.inputPair);
        const selectedInput: payjoin.InputPairLike = receiver.tryPreservingPrivacy(inputPairs);

        receiver = receiver.contributeInputs([selectedInput])
          .commitInputs()
          .save(persister);

        logger.debug('tryContributeInputs complete');
      }

      // Reserve the committed receiver input before signing (issue #8): record
      // it on the Receive row (unique constraint = cross-session/replica claim)
      // and hold a persistent wallet lock. Runs on every pass, including
      // replayed sessions already past WantsInputs, so a crash between commit
      // and lock is healed here. Failing to reserve must abort before
      // finalizeProposal — never sign with an unreserved input.
      if (
        receiver instanceof payjoin.WantsFeeRange ||
        receiver instanceof payjoin.ProvisionalProposal ||
        receiver instanceof payjoin.PayjoinProposal
      ) {
        const reserved = await reserveCommittedInput(receiveSess, persister.load(), config);
        if (!reserved) return;
        receiveSess = reserved;
      }

      if (receiver instanceof payjoin.WantsFeeRange) {
        logger.debug(processReceiveSession, 'Receiver is in WantsFeeRange state');

        const { error: maxFeeError, result: maxFeeResult } = await cnClient.getFeeRate({
          confTarget: 1,
        });
        if (maxFeeError) {
          logger.error(processReceiveSession, 'failed to get fee rate:', maxFeeError);
          return;
        }
        logger.info(processReceiveSession, 'max fee rate:', maxFeeResult?.feerate);

        receiver = receiver.applyFeeRange(BigInt(minFeeResult!.feerate), BigInt(maxFeeResult!.feerate)).save(persister);
      }
      
      if (receiver instanceof payjoin.ProvisionalProposal) {
        logger.debug(processReceiveSession, 'Receiver is in ProvisionalProposal state');

        receiver = receiver.finalizeProposal(
          { callback: (psbt: string) => walletProcessPsbt(psbt, config) }
        )
        .save(persister);
      }
      
      if (receiver instanceof payjoin.PayjoinProposal) {
        logger.debug(processReceiveSession, 'Receiver is in PayjoinProposal state');

        const finalPsbt = receiver.psbt();
        logger.info(processReceiveSession, 'finalized proposal psbt:', finalPsbt);

        // Decode and validate amounts BEFORE sending the proposal so we can abort cleanly
        // if the receiver would lose money.
        const { error: decodedFinalPsbtError, result: decodedFinalPsbtResult } = await cnClient.decodePsbt({ psbt: finalPsbt });
        if (decodedFinalPsbtError || !decodedFinalPsbtResult) {
          logger.error(processReceiveSession, 'failed to decode final psbt:', decodedFinalPsbtError);
          await db.receive.updateMany({ where: { id: receiveSess.id, failedTs: null }, data: { failedTs: new Date(), failedReason: `decode_psbt_failed: ${decodedFinalPsbtError}` } });
          return;
        }

        let totalFee = 0n, receiverFee = 0n, receiverTotalInputAmount = 0n, receiverTotalOutputAmount = 0n;

        totalFee = extractFeeFromPsbt(decodedFinalPsbtResult);
        logger.debug(processReceiveSession, 'total fee:', totalFee);

        // classify by the reserved outpoint rather than a fresh listunspent —
        // the contributed coin is wallet-locked, so on a retried pass it would
        // be missing from availableInputs and misclassified as the sender's
        const txInputs = decodedFinalPsbtResult.inputs.map((input, index) => {
          const address = input.witness_utxo?.scriptPubKey?.address ?? null;
          const amount = Utils.btcToSats(input.witness_utxo?.amount || 0);
          const outpoint = decodedFinalPsbtResult.tx.vin[index];
          const ownedBy: 'sender' | 'receiver' = outpoint != null
            && outpoint.txid === receiveSess.reservedInputTxid
            && outpoint.vout === receiveSess.reservedInputVout
            ? 'receiver' : 'sender';
          return { address, amount: amount.toString(), ownedBy };
        });

        const txOutputs = decodedFinalPsbtResult.tx.vout.map((output) => {
          const address = output.scriptPubKey?.address ?? null;
          const amount = Utils.btcToSats(output.value || 0);
          const ownedBy: 'sender' | 'receiver' | null =
            address === effectiveReceiverAddress ? 'receiver' : address != null ? 'sender' : null;
          return { address, amount: amount.toString(), ownedBy };
        });

        receiverTotalInputAmount = txInputs
          .filter(i => i.ownedBy === 'receiver')
          .reduce((acc, i) => acc + BigInt(i.amount), 0n);
        logger.debug(processReceiveSession, 'total receiver input amount:', receiverTotalInputAmount);

        receiverTotalOutputAmount = txOutputs
          .filter(o => o.ownedBy === 'receiver')
          .reduce((acc, o) => acc + BigInt(o.amount), 0n);
        logger.debug(processReceiveSession, 'total receiver output amount:', receiverTotalOutputAmount);

        const senderTotalInputAmount = txInputs
          .filter(i => i.ownedBy === 'sender')
          .reduce((acc, i) => acc + BigInt(i.amount), 0n);
        logger.debug(processReceiveSession, 'total sender input amount:', senderTotalInputAmount);

        const senderTotalOutputAmount = txOutputs
          .filter(o => o.ownedBy === 'sender')
          .reduce((acc, o) => acc + BigInt(o.amount), 0n);
        logger.debug(processReceiveSession, 'total sender output amount:', senderTotalOutputAmount);

        const netReceived = receiverTotalOutputAmount - receiverTotalInputAmount;

        if (netReceived < 0n) {
          logger.error(processReceiveSession, `receiver would lose ${-netReceived} sats (netReceived < 0) — aborting without sending proposal`);
          // use updateMany with failedTs: null so we only stamp it once — if we unconditionally
          // overwrite it on every retry, failedTs never ages past the 2-min threshold and
          // broadcastFallback can never run
          await db.receive.updateMany({ where: { id: receiveSess.id, failedTs: null }, data: { failedTs: new Date(), failedReason: `net_negative: receiver would lose ${-netReceived} sats` } });
          return;
        }

        // if OutputsUnknown was skipped (restored session), re-derive sender payment from fallback tx
        if (senderPaymentAmount === 0n && receiveSess.fallbackTxHex) {
          const { error: fbError, result: fbResult } = await cnClient.decodeRawTransaction({ hex: receiveSess.fallbackTxHex });
          if (fbError || !fbResult) {
            logger.warn(processReceiveSession, 'could not decode fallback tx to compute sender payment:', fbError);
          } else {
            senderPaymentAmount = fbResult.tx.vout
              .filter(vout => vout.scriptPubKey.address === originalReceiverAddress)
              .reduce((acc, vout) => acc + Utils.btcToSats(vout.value), 0n);
          }
        }

        // receiver_fee = the portion of the total fee absorbed by the receiver (their input's
        // extra weight cost, deducted from their output by the payjoin library). Clamped at 0
        // in case senderPaymentAmount is unknown (0n) or netReceived somehow exceeds it.
        const rawReceiverFee = senderPaymentAmount - netReceived;
        receiverFee = rawReceiverFee > 0n ? rawReceiverFee : 0n;
        logger.debug(processReceiveSession, 'receiver fee:', receiverFee, 'sender payment:', senderPaymentAmount, 'net received:', netReceived);

        // amount = what the sender actually paid = netReceived + receiver's fee contribution.
        // This recovers the full payment amount rather than the reduced net-of-fee figure.
        const calculatedAmount = netReceived + receiverFee;
        let updateAmount = receiveSess.amount;
        const tolerance = 10n;
        const difference = calculatedAmount > receiveSess.amount
          ? calculatedAmount - receiveSess.amount
          : receiveSess.amount - calculatedAmount;

        if (difference > tolerance) {
          logger.warn(
            processReceiveSession,
            `net received differs from expected by ${difference} sats: ` +
            `netReceived=${calculatedAmount}, expected=${receiveSess.amount}`
          );
          updateAmount = calculatedAmount;
        } else if (difference > 0n) {
          logger.info(
            processReceiveSession,
            `net received differs from expected by ${difference} sats (within ${tolerance} tolerance): ` +
            `netReceived=${calculatedAmount}, expected=${receiveSess.amount}`
          );
        }

        const txid = decodedFinalPsbtResult.tx.txid;
        logger.debug(processReceiveSession, 'proposal txid:', txid);

        // NOTE: no utxosToBeLocked() here — it returns every proposal input,
        // the sender's included, and upstream PDK removed the API for that
        // reason. The receiver's own input was already reserved and locked by
        // reserveCommittedInput() before signing.

        // flush persisted state before sending the proposal so a crash after send can replay correctly
        await persister.flush();

        const rr = receiver.createPostRequest(receiveSess.ohttpRelay ?? randomRelay());
        const responseBuffer = await fetchBufferResponse(rr.request);

        // Note: a success response here doesn't mean the sender accepted the PSBT.
        // Fallback tx broadcast is handled separately after a timeout if the payjoin tx is not seen.
        const result = receiver.processResponse(responseBuffer, rr.clientResponse).save(persister);
        logger.debug(processReceiveSession, 'processed proposal response:', result);

        if (txid) {
          const updateResult = await db.receive.update({
            where: { id: receiveSess.id },
            data: {
              txid,
              amount: updateAmount,
              fee: totalFee,
              receiverFee,
              receiverInAmount: receiverTotalInputAmount,
              receiverOutAmount: receiverTotalOutputAmount,
              senderInAmount: senderTotalInputAmount,
              senderOutAmount: senderTotalOutputAmount,
              txInputs,
              txOutputs,
            }
          });
          logger.info(processReceiveSession, 'updated session with txid:', txid, receiveSess.id, updateResult);
        }
      }

    } catch (e) {
      logger.error(processReceiveSession, 'failed to restore session:', describePayjoinError(e));

      if (e instanceof AxiosError && e.code === 'ECONNABORTED' && receiveSess.ohttpRelay) {
        recordRelayFailure(receiveSess.ohttpRelay);
      }

      await db.receive.updateMany({
        where: { id: receiveSess.id, failedTs: null },
        data: {
          failedTs: new Date(),
          failedReason: `exception: ${describePayjoinError(e)}`,
        }
      }).catch((e) => {
        logger.error(processReceiveSession, 'failed to update session with failed timestamp:', e);
      });
    }
  });
}

function canBroadcast(tx: ArrayBuffer): boolean {
  logger.debug(canBroadcast, 'checking if tx can be broadcast:', tx);
  
  const txHex = arrayBufferToHex(tx);

  // ensure that the fallback tx can be broadcast
  const { error: acceptError, result: acceptResult } = syncCnClient.syncTestMempoolAccept({
    rawtx: txHex,
  });
  
  if (acceptError || !acceptResult) {
    logger.error(canBroadcast, 'failed to test mempool accept:', acceptError);
    return false;
  } else if (!acceptResult[0].allowed) {
    logger.info(canBroadcast, 'tx not suitable for broadcast:', acceptResult);
    return false;
  } else {
    logger.info(canBroadcast, 'tx suitable for broadcast:', acceptResult);
    return true;
  }
};

function isOwned(script: ArrayBuffer, config: Config): boolean {
  logger.debug(isOwned, 'checking if script is owned:', script);

  const scriptHex = arrayBufferToHex(script);

  const { error: decodeError, result: decodeResult } = syncCnClient.syncDecodeScript(
    scriptHex,
  );

  if (decodeError || !decodeResult) {
    logger.error(isOwned, 'failed to decode script:', decodeError);
    return false;
  }

  if (!decodeResult.address) {
    logger.debug(isOwned, 'script is not owned:', script);
    return false;
  }

  const { error: receiverAddressError, result: receiverAddressResult } = syncCnClient.syncGetAddressInfo({
    address: decodeResult.address,
    wallet: config.RECEIVE_WALLET,
  });
  if (receiverAddressError || !receiverAddressResult) {
    logger.error(isOwned, 'failed to get address info:', receiverAddressError);
    return false;
  }

  if (receiverAddressResult.ismine) {
    logger.debug(isOwned, 'script is owned by receiver wallet:', script, decodeResult.address);
    return true;
  }

  return false;
}

/**
 * Two-phase seen-input check (BIP 78 anti-probing). The PDK state
 * transition is only persisted AFTER the outpoint claims are durably committed,
 * so a crash or DB failure can never let a session proceed without a claim.
 *
 * Returns the next receiver state on success, or null on a transient DB
 * failure — nothing was saved, so the session replays MaybeInputsSeen next
 * cron cycle (same semantics as the long-poll timeout retry paths; throwing
 * instead would stamp failedTs and burn the payjoin on a DB blip).
 *
 * On a cross-session conflict the rejection transition's save() throws; that
 * propagates to processReceiveSession's catch-all, which stamps
 * failedTs/failedReason. The next cycle replays to HasReplyableError, delivers
 * the error to the sender, and broadcastFallback later broadcasts the fallback.
 */
export async function checkNoInputsSeen(
  receiver: payjoin.MaybeInputsSeen,
  bip21: string,
  persister: ReceiverPersister,
  sessionId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  // Phase 1: collect-only pass — gather outpoints, tentatively report every
  // one unseen, and HOLD the resulting transition without saving it.
  const collected: SeenOutpoint[] = [];
  const tentative = receiver.checkNoInputsSeenBefore({
    callback: (outpoint: payjoin.OutPoint) => {
      collected.push({ txid: outpoint.txid, vout: Number(outpoint.vout) });
      return false;
    },
  });

  // Phase 2: durably claim the outpoints before persisting protocol progress.
  try {
    await claimSeenInputsForSession(bip21, collected);
  } catch (e) {
    if (e instanceof SeenInputConflictError) {
      logger.warn(checkNoInputsSeen,
        `seen-input conflict for session ${sessionId} — rejecting proposal as probe:`, [...e.conflicts]);
      // Rerun on the same receiver (the FFI method takes &self and clones
      // internally — re-verify on payjoin npm upgrades), now reporting the
      // conflicting outpoints as seen so the normal PDK rejection is what
      // gets persisted. This save() throws to the caller's catch-all.
      receiver.checkNoInputsSeenBefore({
        callback: (outpoint: payjoin.OutPoint) => e.conflicts.has(outpointKey(outpoint)),
      }).save(persister);
      return null; // defensive — save() throws for the rejection transition
    }
    logger.error(checkNoInputsSeen,
      `seen-input claim failed — failing closed, retrying next cycle (session ${sessionId}):`, e);
    return null;
  }

  // Claims are durable — only now persist the successful transition.
  return tentative.save(persister);
}

/**
 * Reserve the receiver input committed to this session's payjoin proposal
 * (issue #8): record the outpoint on the Receive row — the composite unique
 * constraint makes the claim atomic across sessions and replicas — then hold
 * a persistent wallet lock so the coin survives bitcoind restarts and is
 * excluded from other sessions' availableInputs.
 *
 * Idempotent: a re-pass of a session that already owns its claim only
 * re-verifies the wallet lock ("already locked" is safely ours by virtue of
 * the DB claim). Returns the up-to-date Receive row, or null if the session
 * must not proceed to signing:
 *  - claim conflict (another session owns the outpoint) or an unidentifiable
 *    committed input stamps failedTs, so the existing fallback machinery
 *    closes the session (the fallback never spends this input, so it is safe);
 *  - a transient lock/DB failure stamps nothing and is retried next cycle.
 */
export async function reserveCommittedInput(receiveSess: Receive, sessionEvents: unknown[], config: Config): Promise<Receive | null> {
  const committed = extractCommittedInputs(sessionEvents);
  if (!committed || committed.length !== 1) {
    logger.error(reserveCommittedInput, `cannot identify committed receiver input for session ${receiveSess.id}:`, committed);
    await db.receive.updateMany({
      where: { id: receiveSess.id, failedTs: null },
      data: { failedTs: new Date(), failedReason: 'input_reservation_failed: cannot identify committed receiver input' },
    });
    return null;
  }
  const { txid, vout } = committed[0];

  if (receiveSess.reservedInputTxid !== txid || receiveSess.reservedInputVout !== vout) {
    if (receiveSess.reservedInputTxid != null) {
      // a session's committed input is immutable, so a mismatch means corrupted state
      logger.error(reserveCommittedInput,
        `session ${receiveSess.id} reserved ${receiveSess.reservedInputTxid}:${receiveSess.reservedInputVout} but committed ${txid}:${vout}`);
      await db.receive.updateMany({
        where: { id: receiveSess.id, failedTs: null },
        data: { failedTs: new Date(), failedReason: 'input_reservation_failed: reservation does not match committed input' },
      });
      return null;
    }

    try {
      receiveSess = await db.receive.update({
        where: { id: receiveSess.id },
        data: { reservedInputTxid: txid, reservedInputVout: vout },
      });
      logger.info(reserveCommittedInput, `reserved input ${txid}:${vout} for session ${receiveSess.id}`);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        logger.warn(reserveCommittedInput,
          `input ${txid}:${vout} is reserved by another session — failing session ${receiveSess.id}`);
        await db.receive.updateMany({
          where: { id: receiveSess.id, failedTs: null },
          data: { failedTs: new Date(), failedReason: `input_reservation_conflict: ${txid}:${vout} reserved by another session` },
        });
      } else {
        logger.error(reserveCommittedInput, `failed to record reservation for session ${receiveSess.id} — retrying next cycle:`, e);
      }
      return null;
    }
  }

  const { error, result } = await cnClient.lockUnspent({
    utxos: [{ txid, vout }],
    persistent: true,
    wallet: config.RECEIVE_WALLET,
  });
  if (!error && result?.success === true) return receiveSess;

  // The wallet lock has no owner concept; the DB claim above is what makes an
  // existing lock safely ours (an idempotent re-pass, or a lock from a pass
  // that crashed before signing).
  if (/already locked/i.test(String(error?.message ?? ''))) return receiveSess;

  logger.error(reserveCommittedInput,
    `failed to lock reserved input ${txid}:${vout} for session ${receiveSess.id} — not signing:`, error ?? result);
  return null;
}

/**
 * Idempotent release of a terminal session's receiver-input reservation
 * (issue #8). Operates only on the outpoint recorded on this Receive row —
 * never on the wallet's global lock list.
 *
 * Release rules:
 *  - proposal never posted: the receiver-signed proposal is unbroadcastable
 *    (the sender must re-sign its inputs) and the fallback does not spend our
 *    input, so a cancelled/expired/failed session unlocks and releases
 *    immediately;
 *  - proposal posted: hold until confirmedTs. A tx seen only in the mempool
 *    never sets confirmedTs, so it never releases anything. Once confirmed:
 *      - the payjoin itself confirmed: the reserved input is spent and Core
 *        removed its wallet lock when the spending tx arrived — just clear
 *        the reservation, no unlock RPC;
 *      - the conflicting original/fallback confirmed: the input is unspent,
 *        so unlock it and clear;
 *      - the confirmed tx is neither (an unrelated payment to the same
 *        address): keep the reservation — the posted proposal could still be
 *        broadcast.
 *
 * When an unlock is needed, the reservation is only cleared after it succeeds
 * or the outpoint is already gone/unlocked; otherwise the next sweep retries.
 */
export async function releaseReservedInput(receiveSess: Receive, config: Config) {
  await lock.acquire([receiveSess.id.toString(), receiveSess.address], async () => {
    try {
      // re-read inside the lock — processReceiveSession may have just run
      const fresh = await db.receive.findUnique({ where: { id: receiveSess.id } });
      if (!fresh?.reservedInputTxid || fresh.reservedInputVout == null) return;

      const utxo = { txid: fresh.reservedInputTxid, vout: fresh.reservedInputVout };
      // true when the reserved input was spent by the confirmed payjoin —
      // nothing left to unlock (Core removed the lock when the tx arrived)
      let spentByPayjoin = false;

      const posted = sessionHasPostedProposal(fresh.session);
      // Bounded hold (issue #8): a posted proposal normally only releases on a
      // confirmed on-chain outcome, but that outcome may never come (sender
      // vanished without broadcasting; row txid wedged by an unrelated
      // payment). A generous grace period past session expiry bounds the hold:
      // by then the abandoned-posted sweep has been broadcasting the
      // conflicting fallback every cycle, so an outcome that was going to
      // confirm has had ample time. If the reserved input turns out to be
      // spent after all, the unlock below tolerates it ("expected unspent
      // output" counts as released).
      const graceExpired = fresh.expiryTs != null
        && Date.now() > fresh.expiryTs.getTime() + config.RESERVATION_RELEASE_GRACE * 1000;
      if (posted) {
        if (!fresh.confirmedTs) {
          if (!graceExpired) {
            logger.debug(releaseReservedInput, `session ${fresh.id} posted its proposal but has no confirmed outcome — keeping reservation`);
            return;
          }
          logger.warn(releaseReservedInput,
            `session ${fresh.id} posted its proposal but nothing confirmed within ${config.RESERVATION_RELEASE_GRACE}s of expiry — force-releasing reservation`);
        } else if (fresh.nonPayjoinTs) {
          // The confirmed tx is not the proposal. It is almost always the
          // sender-broadcast original (which conflicts with the proposal), but
          // an unrelated payment to the watched address takes the same code
          // path — only the original proves the proposal can no longer confirm.
          let originalTxid: string | undefined;
          if (fresh.fallbackTxHex) {
            const { result: decodeResult } = await cnClient.decodeRawTransaction({ hex: fresh.fallbackTxHex });
            originalTxid = decodeResult?.tx?.txid;
          }
          if (!originalTxid || fresh.txid !== originalTxid) {
            if (!graceExpired) {
              logger.warn(releaseReservedInput,
                `session ${fresh.id}: confirmed tx ${fresh.txid} is neither the payjoin nor the original — keeping reservation`);
              return;
            }
            logger.warn(releaseReservedInput,
              `session ${fresh.id}: confirmed tx ${fresh.txid} is neither the payjoin nor the original, but reservation grace has expired — force-releasing`);
          }
        } else if (!fresh.fallbackTs) {
          // row.txid is the proposal itself (only the non-payjoin/fallback
          // paths overwrite it), so the confirmed tx spent our input
          spentByPayjoin = true;
        }
      }

      if (!spentByPayjoin) {
        const { error, result } = await cnClient.lockUnspent({
          unlock: true,
          persistent: true,
          utxos: [utxo],
          wallet: config.RECEIVE_WALLET,
        });
        // Defensive: treat already-gone outpoints as released (coin spent
        // outside the session — "expected unspent output" — or lock already
        // dropped). Core removes a lock itself when a spending tx arrives.
        const released = (!error && result?.success === true)
          || /expected unspent output|expected locked output|unknown transaction|vout index out of bounds/i.test(String(error?.message ?? ''));
        if (!released) {
          logger.error(releaseReservedInput,
            `failed to unlock ${utxo.txid}:${utxo.vout} for session ${fresh.id} — will retry next sweep:`, error ?? result);
          return;
        }
      }

      await db.receive.update({
        where: { id: fresh.id },
        data: { reservedInputTxid: null, reservedInputVout: null },
      });
      logger.info(releaseReservedInput, `released reserved input ${utxo.txid}:${utxo.vout} for session ${fresh.id}`);
    } catch (e) {
      logger.error(releaseReservedInput, `failed to release reservation for session ${receiveSess.id}:`, e);
    }
  });
}

export async function availableInputs(config: Config, targetSats: bigint): Promise<InputPairWithMetadata[]> {
  const { error: utxosError, result: utxosResult } = await cnClient.listUnspent({ wallet: config.RECEIVE_WALLET });
  if (utxosError || !utxosResult) {
    logger.error(availableInputs, 'failed to list unspent:', utxosError);
    return [];
  }

  logger.debug(availableInputs, 'found utxos:', utxosResult.utxos.length);

  // Exclude outpoints reserved by other sessions (issue #8). The DB
  // reservation, not wallet-lock state, is the source of truth: Core removes
  // the wallet lock as soon as the payjoin tx enters the mempool, and the lock
  // can lag the claim in the crash window before reserveCommittedInput heals
  // it. Cheap by construction — reservations are cleared on release, so this
  // only ever returns currently-held rows via the unique index.
  const reservedRows = await db.receive.findMany({
    where: { reservedInputTxid: { not: null } },
    select: { reservedInputTxid: true, reservedInputVout: true },
  });
  const reserved = new Set(
    reservedRows.map((r) => outpointKey({ txid: r.reservedInputTxid!, vout: r.reservedInputVout! }))
  );
  if (reserved.size > 0) {
    logger.debug(availableInputs, 'excluding reserved outpoints:', [...reserved]);
  }

  // Order candidates by how close their value is to the payment amount, closest first.
  //
  // The PDK's tryPreservingPrivacy() returns the FIRST candidate that avoids the
  // Unnecessary-Input Heuristic (UIH2), so the order we hand it decides which UTXO is
  // contributed.
  //
  // Targeting the payment amount makes the contributed input look like a natural,
  // wallet-selected coin (a single-input payment normally spends a coin in the ballpark
  // of payment + fee + change), so amount-magnitude clustering can't single it out as the
  // receiver's.
  const abs = (n: bigint): bigint => (n < 0n ? -n : n);
  const sortedUtxos = [...utxosResult.utxos]
    .filter((utxo) =>
      utxo.confirmations > 0 &&
      Utils.btcToSats(utxo.amount) > 0n &&
      !reserved.has(outpointKey(utxo)))
    .sort((a, b) => {
      const da = abs(Utils.btcToSats(a.amount) - targetSats);
      const db = abs(Utils.btcToSats(b.amount) - targetSats);
      return da < db ? -1 : da > db ? 1 : 0;
    });
  logger.debug(availableInputs, 'sorted utxos:', sortedUtxos.length);

  const inputs: InputPairWithMetadata[] = [];
  for (const utxo of sortedUtxos) {
    const { error: txError, result: txResult } = await cnClient.getTransaction(utxo.txid);
    if (txError || !txResult) {
      logger.error(availableInputs, 'failed to get transaction:', txError);
      continue;
    }
    logger.debug(availableInputs, 'got transaction for utxo:', txResult);

    const txin = payjoin.TxIn.create({
      previousOutput: payjoin.OutPoint.create({
        txid: utxo.txid,
        vout: utxo.vout,
      }),
      scriptSig: new Uint8Array([]).buffer,
      sequence: 0,
      witness: [],
    });

    const txOut = payjoin.TxOut.create({
      valueSat: Utils.btcToSats(utxo.amount),
      scriptPubkey: new Uint8Array(Buffer.from(utxo.scriptPubKey, "hex")).buffer,
    });
    const psbtIn = payjoin.PsbtInput.create({
        witnessUtxo: txOut,
        redeemScript: undefined,
        witnessScript: undefined,
    });
    logger.debug(availableInputs, 'created input pair for utxo:', txin, psbtIn);

    inputs.push({
      inputPair: new payjoin.InputPair(txin, psbtIn, undefined),
      txid: utxo.txid,
      vout: utxo.vout,
      amount: utxo.amount,
      scriptPubKey: utxo.scriptPubKey,
    });
    logger.debug(availableInputs, 'added input pair for utxo:', utxo.txid, utxo.vout);

    // limit to 20 inputs to provide to payjoin library
    if (inputs.length >= 20) {
      break;
    }
  }
  logger.debug(availableInputs, 'selected inputs:', inputs);

  return inputs;
}

function walletProcessPsbt(provisionalPsbt: string, config: Config): string {
    logger.debug(walletProcessPsbt, 'provisional proposal psbt:', provisionalPsbt);

    const { error: processError, result: processResult } = syncCnClient.syncProcessPsbt({
      psbt: provisionalPsbt,
      finalize: true,
      wallet: config.RECEIVE_WALLET,
    });

    if (processError || !processResult) {
      logger.error(walletProcessPsbt, 'failed to process psbt:', processError);
      throw new Error('failed to process psbt');
    }
    logger.debug(walletProcessPsbt, 'processed psbt:', processResult);

    return processResult.psbt;
}

/**
 * Sum the value of PSBT inputs that belong to the receiver, identified by outpoint
 * (txid + vout index). `psbtInputs` and `vin` are parallel arrays from `decodePsbt`.
 */
export function sumReceiverInputs(
  psbtInputs: Array<{ witness_utxo?: { amount: number } }>,
  vin: Array<{ txid: string; vout: number }>,
  contributedInputs: Array<{ txid: string; vout: number | bigint }>,
): bigint {
  return psbtInputs.reduce((acc, input, index) => {
    if (!input.witness_utxo?.amount) return acc;
    const outpoint = vin[index];
    if (!outpoint) return acc;
    const isOurs = contributedInputs.some(
      (c) => c.txid === outpoint.txid && Number(c.vout) === outpoint.vout,
    );
    return isOurs ? acc + Utils.btcToSats(input.witness_utxo.amount) : acc;
  }, 0n);
}

export async function broadcastFallback(receiveSess: Receive, config: Config) {
  logger.debug(broadcastFallback, 'broadcasting fallback tx for receiveSess:', receiveSess.id);

  if (!receiveSess.fallbackTxHex) {
    logger.error(broadcastFallback, 'no fallback tx hex found');
    return;
  }

  // issue #6: a null firstSeenTs only proves the address-watch callback hasn't
  // fired — ask the node directly before broadcasting the conflicting fallback.
  // receiveSess.txid is the posted payjoin proposal txid here (the failed-session
  // queue filters txid: null). Only a definite not-found (bitcoind -5) may
  // proceed; any other lookup failure is an unknown outcome — retry next cycle.
  if (receiveSess.txid) {
    const { error: lookupError, result: lookupResult } = await cnClient.getTransaction(receiveSess.txid);
    if (lookupResult?.txid) {
      logger.info(broadcastFallback, `payjoin tx ${receiveSess.txid} in mempool — skipping fallback broadcast for session ${receiveSess.id}`);
      await db.receive.update({
        where: { id: receiveSess.id },
        data: { firstSeenTs: receiveSess.firstSeenTs ?? new Date() },
      }).catch((e) => logger.error(broadcastFallback, 'failed to record firstSeenTs:', e));
      return;
    }
    if (lookupError?.code !== -5) {
      logger.warn(broadcastFallback, `payjoin tx lookup failed for session ${receiveSess.id} — deferring fallback broadcast:`, lookupError);
      return;
    }
  }

  const { error: decodeError, result: decodeResult } = await cnClient.decodeRawTransaction({ hex: receiveSess.fallbackTxHex });
  if (decodeError || !decodeResult) {
    logger.error(broadcastFallback, 'failed to decode fallback tx:', decodeError);
    return;
  }

  // The sender always pays the original BIP21 address regardless of whether
  // we later substituted our output to a fresh address. receiveSess.address
  // may have been updated during output substitution, so derive the original
  // receiver address from the stored BIP21 instead.
  const originalAddress = receiveSess.bip21
    ? receiveSess.bip21.replace(/^bitcoin:/i, '').split('?')[0]
    : receiveSess.address;

  const fallbackAmount = decodeResult.tx.vout
    .filter(vout => vout.scriptPubKey.address === originalAddress)
    .reduce((acc, vout) => acc + Utils.btcToSats(vout.value), 0n);
  logger.info(broadcastFallback, 'fallback amount to receiver:', fallbackAmount);

  const { error: sendError, result: sendResult } = await cnClient.sendRawTransaction({
    hex: receiveSess.fallbackTxHex,
    wallet: config.RECEIVE_WALLET,
  });

  if (sendError || !sendResult) {
    const errMsg = String(sendError?.message ?? '');

    // Errors that can never clear on retry:
    //  - inputs already spent: a conflicting confirmed tx consumed the same
    //    outpoints (e.g. the winning session's fallback after a rejected probe)
    //    — this is a genuine failure of the economic protection: this
    //    session's fallback can never confirm, so it's logged as an error
    //  - already in chain: this exact tx is already confirmed, so the sender
    //    beat us to the broadcast — benign, the payment outcome still exists
    // In both cases stop retrying: stamp fallbackAbandonedTs to drop the
    // session out of the retry queue (fallbackTxHex is kept for the record)
    // and note why. Payment accounting is never done here — only the
    // address-watch callback may mark a session as paid.
    const terminalReason =
      /missingorspent|missing inputs/i.test(errMsg) ? 'inputs already spent' :
      /already in block ?chain|txn-already-known|already known|outputs already in utxo set/i.test(errMsg)
        ? 'tx already broadcast' :
      null;

    if (terminalReason) {
      const logFn = terminalReason === 'inputs already spent' ? logger.error : logger.warn;
      logFn(broadcastFallback, `abandoning fallback retries for session ${receiveSess.id}: ${terminalReason}`);
      await db.receive.update({
        where: { id: receiveSess.id },
        data: {
          fallbackAbandonedTs: new Date(),
          failedReason: `${receiveSess.failedReason ?? 'fallback failed'}; fallback abandoned: ${terminalReason}`,
        },
      }).catch((e) => logger.error(broadcastFallback, 'failed to mark fallback abandoned:', e));
      return;
    }

    // anything else (mempool conflict, fee policy, transient RPC failure) may
    // clear on its own — leave the session in the queue and retry next cron
    logger.error(broadcastFallback, 'failed to broadcast fallback tx:', sendError);
    return;
  }

  logger.info(broadcastFallback, 'broadcasted fallback tx:', sendResult);

  // update the receive session with the txid and actual received amount from the fallback tx
  const updatedReceive = await db.receive.update({
    where: { id: receiveSess.id },
    data: {
      txid: sendResult,
      fallbackTs: new Date(),
      amount: fallbackAmount,
    }
  });
  logger.info(broadcastFallback, 'updated receive session with txid:', sendResult, updatedReceive.id);
}