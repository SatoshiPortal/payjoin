import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Send } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { extractFeeFromPsbt, fetchBufferResponse, randomRelay, withRelayFallback } from "../lib/payjoin";
import { SenderPersister } from "../lib/persister";
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
