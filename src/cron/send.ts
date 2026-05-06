import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Send } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { extractFeeFromPsbt, fetchBufferResponse } from "../lib/payjoin";
import { SenderPersister } from "../lib/persister";

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
        const { request, ohttpCtx } = sender.createV2PostRequest(config.OHTTP_RELAY);
        const responseBuffer = await fetchBufferResponse(request);
        sender.processResponse(responseBuffer, ohttpCtx).save(persister);

        logger.info(processSendSession, 'Initial V2 post complete — session advanced to PollingForProposal');
        return;
      }

      if (payjoin.SendSession.PollingForProposal.instanceOf(sessionState)) {
        logger.debug(processSendSession, 'Sender is in PollingForProposal state — polling for proposal');

        const sender = sessionState.inner.inner;
        const { request, ohttpCtx } = sender.createPollRequest(config.OHTTP_RELAY);
        const responseBuffer = await fetchBufferResponse(request);
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

        const { error: processedError, result: processedResult } = await cnClient.processPsbt({
          psbt: psbtBase64,
          finalize: true,
          sign: true,
          wallet: config.SEND_WALLET
        });

        if (processedError || !processedResult) {
          logger.error(processSendSession, 'failed to process psbt:', processedError);
          return;
        }

        if (!processedResult.complete) {
          logger.error(processSendSession, 'payjoin proposal PSBT could not be fully signed', processedResult);
          return;
        }

        const { error: finalizeError, result: finalizeResult } = await cnClient.finalizePsbt({
          psbt: processedResult.psbt,
          extract: true,
          wallet: config.SEND_WALLET
        });

        if (finalizeError || !finalizeResult) {
          logger.error(processSendSession, 'failed to finalize psbt:', finalizeError);
          return;
        }

        if (!finalizeResult.hex) {
          logger.error(processSendSession, 'failed to extract transaction hex:', finalizeResult);
          return;
        }

        const { error: sendError, result: sendResult } = await cnClient.sendRawTransaction({
          hex: finalizeResult.hex,
          wallet: config.SEND_WALLET
        });

        if (sendError) {
          logger.error(processSendSession, 'failed to send transaction:', sendError);
          return;
        }

        let totalFee = 0n, senderFee = 0n, senderTotalInputAmount = 0n, senderTotalOutputAmount = 0n;
        const { error: decodedFinalPsbtError, result: decodedFinalPsbtResult } = await cnClient.decodePsbt({ psbt: processedResult.psbt! });
        if (decodedFinalPsbtError || !decodedFinalPsbtResult) {
          logger.error(processSendSession, 'failed to decode final psbt:', decodedFinalPsbtError);
        } else {
          totalFee = extractFeeFromPsbt(decodedFinalPsbtResult);
          logger.debug(processSendSession, 'total fee:', totalFee);

          senderTotalInputAmount = decodedFinalPsbtResult.inputs
            .filter((input) =>
              input.witness_utxo &&
              input.witness_utxo.scriptPubKey.address &&
              isAddressOwned(input.witness_utxo.scriptPubKey.address, config)
            )
            .reduce((acc, input) => acc + Utils.btcToSats(input.witness_utxo?.amount || 0), 0n);
          logger.debug(processSendSession, 'total sender input amount:', senderTotalInputAmount);

          senderTotalOutputAmount = decodedFinalPsbtResult.tx.vout
            .filter((output) =>
              output.scriptPubKey.address &&
              isAddressOwned(output.scriptPubKey.address, config)
            )
            .reduce((acc, output) => acc + Utils.btcToSats(output.value || 0), 0n);
          logger.debug(processSendSession, 'total sender output amount:', senderTotalOutputAmount);

          const rawFee = senderTotalInputAmount - senderTotalOutputAmount - sendSess.amount;
          senderFee = rawFee >= 0n ? rawFee : 0n;
          if (rawFee < 0n) {
            logger.warn(processSendSession, 'sender fee calculation produced negative value — address ownership may be misclassified:', rawFee);
          }
          logger.debug(processSendSession, 'sender fee:', senderFee);
        }

        if (sendResult) {
          const updateResult = await db.send.update({
            where: { id: sendSess.id },
            data: {
              txid: sendResult,
              fee: totalFee,
              senderFee,
              senderInAmount: senderTotalInputAmount,
              senderOutAmount: senderTotalOutputAmount,
            }
          });

          logger.info(processSendSession, 'updated session with txid:', sendResult);
          logger.info(processSendSession, 'updated session:', updateResult);
        } else {
          logger.error(processSendSession, 'broadcast succeeded but no txid returned');
        }

        return;
      }

      logger.info(processSendSession, 'Session is in terminal state (Closed), skipping:', sessionState.tag);

    } catch (e) {
      logger.error(processSendSession, 'failed to restore session:', e);
    }
  });
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
