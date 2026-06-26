import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Receive } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { AxiosError } from "axios";
import { arrayBufferToHex, describePayjoinError, extractFeeFromPsbt, extractReplyableError, fetchBufferResponse, randomRelay, recordRelayFailure } from "../lib/payjoin";
import { addressCallbackUrl } from "../api/callback/address";
import { ReceiverPersister } from "../lib/persister";

  interface InputPairWithMetadata {
    inputPair: payjoin.InputPair;
    txid: string;
    vout: number;
    amount: number | string;
    scriptPubKey: string;
  }

export async function restoreReceiveSessions(config: Config) {
  logger.info(restoreReceiveSessions, 'restoring receive sessions');

  await cleanupSeenInputs(Number(config.PAYJOIN_RECEIVE_EXPIRY) * 1000);

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
}

async function processReceiveSession(receiveSess: Receive, config: Config) {
  // lock on both id and address - cancel uses id, watch uses address
  await lock.acquire([receiveSess.id.toString(), receiveSess.address!], async () => {
    logger.info(processReceiveSession, 'restoring session:', receiveSess.id);

    if (receiveSess.txid) {
      // @todo this should potentially check for a fallback timeout period and broadcast the fallback tx
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

        const seenInputsMap = await loadSeenInputsFromDb(Number(config.PAYJOIN_RECEIVE_EXPIRY) * 1000);
        const sessionNewInputs = new Set<string>();
        receiver = receiver.checkNoInputsSeenBefore(
          { callback: (outpoint: payjoin.PlainOutPoint) => isKnownProbe(outpoint, receiveSess.bip21!, sessionNewInputs, seenInputsMap) }
        ).save(persister);

        await saveKnownInputs(receiveSess.bip21!, sessionNewInputs);

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

      // get appropriate inputs to contribute - these are outside the WantsInputs block as we use them later also
      // target the payment amount so the contributed input resembles a natural wallet-selected coin (see availableInputs)
      const inputs = await availableInputs(config, receiveSess.amount);
      logger.debug(processReceiveSession, 'selected inputs:', inputs);

      if (receiver instanceof payjoin.WantsInputs) {
        logger.debug(processReceiveSession, 'Receiver is in WantsInputs state');

        if (inputs.length === 0) {
          logger.error(processReceiveSession, 'no inputs found to contribute');
          return;
        }

        const inputPairs = inputs.map((input) => input.inputPair);
        const selectedInput = receiver.tryPreservingPrivacy(inputPairs);
        logger.debug("SELECTED INPUT:", selectedInput, JSON.stringify(selectedInput));

        // Lock the selected UTXO BEFORE signing to close the race window where
        // two concurrent sessions could both select and sign with the same UTXO.
        // indexOf uses identity (===) — works as long as the SDK returns the same
        // InputPair reference it was given, which the WASM bindings do.
        // Cast to InputPairLike[] so indexOf accepts the InputPairLike return type
        // from tryPreservingPrivacy without a type error.
        const selectedIndex = (inputPairs as payjoin.InputPairLike[]).indexOf(selectedInput);
        if (selectedIndex >= 0) {
          const { txid, vout } = inputs[selectedIndex];
          logger.info(processReceiveSession, 'locking selected input before signing:', txid, vout);
          await cnClient.lockUnspent({ utxos: [{ txid, vout: Number(vout) }], wallet: config.RECEIVE_WALLET });
        } else {
          logger.warn(processReceiveSession, 'could not match selected InputPair to metadata — UTXO lock deferred to after signing');
        }

        receiver = receiver.contributeInputs([selectedInput])
          .commitInputs()
          .save(persister);

        logger.debug('tryContributeInputs complete');
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

        const txInputs = decodedFinalPsbtResult.inputs.map((input, index) => {
          const address = input.witness_utxo?.scriptPubKey?.address ?? null;
          const amount = Utils.btcToSats(input.witness_utxo?.amount || 0);
          const outpoint = decodedFinalPsbtResult.tx.vin[index];
          const ownedBy: 'sender' | 'receiver' = outpoint != null && inputs.some(
            (c) => c.txid === outpoint.txid && Number(c.vout) === outpoint.vout
          ) ? 'receiver' : 'sender';
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

        // lock utxos using utxosToBeLocked
        const toLock = receiver.utxosToBeLocked();
        logger.debug(processReceiveSession, 'utxos to be locked:', toLock);

        if (toLock && toLock.length > 0) {
          const lockUtxos = toLock.map((utxo) => {
            const { txid, vout } = utxo;
            return {
              txid,
              vout: Number(vout),
            }
          });

          for (const utxo of lockUtxos) {
            await cnClient.lockUnspent({ utxos: [utxo], wallet: config.RECEIVE_WALLET });
          }
        }

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

export function isKnownProbe(
  outpoint: { txid: string; vout: number | bigint },
  currentBip21: string,
  newInputs: Set<string>,
  seenInputsMap: Map<string, string>,
): boolean {
  const outpointKey = `${outpoint.txid}:${outpoint.vout}`;
  const seenBip21 = seenInputsMap.get(outpointKey);

  if (seenBip21 === undefined) {
    newInputs.add(outpointKey);
    return false;
  }

  if (seenBip21 === currentBip21 || seenBip21 === '') {
    return false;
  }

  logger.debug(isKnownProbe, 'probe detected — outpoint seen with different BIP21:',
    outpointKey, 'seen:', seenBip21, 'current:', currentBip21);
  return true;
}

async function loadSeenInputsFromDb(expiryWindowMs: number): Promise<Map<string, string>> {
  const cutoff = new Date(Date.now() - expiryWindowMs);
  const recentInputs = await db.seenInputs.findMany({ where: { createdTs: { gt: cutoff } } });
  return new Map(recentInputs.map(input => [`${input.txid}:${input.vout}`, input.bip21 || '']));
}

async function cleanupSeenInputs(expiryWindowMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - expiryWindowMs);
  try {
    const { count } = await db.seenInputs.deleteMany({ where: { createdTs: { lte: cutoff } } });
    if (count > 0) logger.info(cleanupSeenInputs, `deleted ${count} expired seen_inputs rows`);
  } catch (e) {
    logger.error(cleanupSeenInputs, 'failed to clean up seen_inputs:', e);
  }
}

async function saveKnownInputs(bip21: string, newInputs: Set<string>) {
  const newInputsArray = Array.from(newInputs);
  if (newInputsArray.length === 0) return;

  try {
    await db.seenInputs.createMany({
      data: newInputsArray.map((input) => {
        const [txid, vout] = input.split(':');
        return { txid, vout: Number(vout), bip21 };
      }),
      skipDuplicates: true,
    });
    logger.debug(saveKnownInputs, 'saved new inputs:', newInputsArray);
  } catch (e) {
    logger.error(saveKnownInputs, 'failed to save new inputs:', e);
  }
}

async function availableInputs(config: Config, targetSats: bigint): Promise<InputPairWithMetadata[]> {
  const { error: utxosError, result: utxosResult } = await cnClient.listUnspent({ wallet: config.RECEIVE_WALLET });
  if (utxosError || !utxosResult) {
    logger.error(availableInputs, 'failed to list unspent:', utxosError);
    return [];
  }

  logger.debug(availableInputs, 'found utxos:', utxosResult.utxos.length);

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
    .filter((utxo) => utxo.confirmations > 0 && Utils.btcToSats(utxo.amount) > 0n)
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

    const txin = payjoin.PlainTxIn.create({
      previousOutput: payjoin.PlainOutPoint.create({
        txid: utxo.txid,
        vout: utxo.vout,
      }),
      scriptSig: new Uint8Array([]).buffer,
      sequence: 0,
      witness: [],
    });

    const txOut = payjoin.PlainTxOut.create({
      valueSat: Utils.btcToSats(utxo.amount),
      scriptPubkey: new Uint8Array(Buffer.from(utxo.scriptPubKey, "hex")).buffer,
    });
    const psbtIn = payjoin.PlainPsbtInput.create({
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