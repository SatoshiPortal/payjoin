import { PayjoinSender } from "payjoin-ts";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config, config } from "../config";
import { Send } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { extractFeeFromPsbt } from "../lib/payjoin";

export async function restoreSendSessions() {
  logger.info(restoreSendSessions, 'restoring send sessions');

  const sessions = await db.send.findMany({
    where: {
      confirmedTs: null,
      cancelledTs: null,
      expiryTs: {
        gt: new Date()
      },
      session: { not: null },
    }
  });
  logger.info(restoreSendSessions, `found ${sessions.length} sessions to restore`);

  for (const sendSess of sessions) {
    await processSendSession(sendSess);
  }
} 

export async function processSendSession(sendSess: Send) {
  // lock on both id and address - cancel uses id, watch uses address
  await lock.acquire([sendSess.id.toString(), sendSess.address!], async () => {
    logger.info(processSendSession, 'restoring session:', sendSess.id);

    if (sendSess.txid) {
      logger.info(processSendSession, 'session already has txid:', sendSess.txid);
      return;
    }

    try {
      const restoredSender = PayjoinSender.fromJson(sendSess.session!);
      logger.debug(processSendSession, 'restored sender successfully');

      const request = await restoredSender.extractV2(config.OHTTP_RELAY);
      logger.debug(processSendSession, 'extractV2 request complete');

      const responseBytes = await request.post();
      const response = await request.processResponse(responseBytes);
      logger.debug(processSendSession, 'post request. Got response');

      const v2Context = response.v2Context();
      if (!v2Context) {
        logger.error(processSendSession, 'v2Context is null. Try again later');
        return;
      }
      logger.debug(processSendSession, 'v2context complete');

      const finalRequest = await v2Context.extractRequest(config.OHTTP_RELAY);
      logger.debug(processSendSession, 'extractRequest got final request');

      const finalResponseBytes = await finalRequest.post();
      const finalResponse = await v2Context.processResponse(finalResponseBytes, finalRequest);

      if (finalResponse && finalResponse.length > 0) {
        // at this point we assume it is a psbt. We'll try to process, finalize and broadcast
        const { error: processedError, result: processedResult } = await cnClient.processPsbt({
          psbt: finalResponse,
          finalize: true, 
          sign: true, 
          wallet: config.SEND_WALLET 
        });

        if (processedError || !processedResult) {
          logger.error(processSendSession, 'failed to process psbt:', processedError);
          return;
        }

        if (!processedResult.complete) {
          logger.error(processSendSession, 'failed to complete psbt:', processedResult);
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

        let totalFee = 0n, senderFee = 0n;
        const { error: decodedFinalPsbtError, result: decodedFinalPsbtResult } = await cnClient.decodePsbt({ psbt: processedResult.psbt! });
        if (decodedFinalPsbtError || !decodedFinalPsbtResult) {
          logger.error(processSendSession, 'failed to decode final psbt:', decodedFinalPsbtError);
        } else {
          // full fee for the transaction
          totalFee = extractFeeFromPsbt(decodedFinalPsbtResult);
          logger.debug(processSendSession, 'total fee:', totalFee);

          // total amount of all our inputs
          const senderTotalInputAmount = decodedFinalPsbtResult.inputs
            .filter((input) => 
              input.witness_utxo && 
              input.witness_utxo.scriptPubKey.address && 
              isAddressOwned(input.witness_utxo.scriptPubKey.address, config)
            )
            .reduce((acc, input) => acc + Utils.btcToSats(input.witness_utxo?.amount || 0), 0n);
          logger.debug(processSendSession, 'total sender input amount:', senderTotalInputAmount);

          // get the amount of our output
          const senderTotalOutputAmount = decodedFinalPsbtResult.tx.vout
            .filter((output) => 
              output.scriptPubKey.address && 
              isAddressOwned(output.scriptPubKey.address, config)
            )
            .reduce((acc, output) => acc + Utils.btcToSats(output.value || 0), 0n);
          logger.debug(processSendSession, 'total sender output amount:', senderTotalOutputAmount);

          // calculate the sender fee
          senderFee = senderTotalInputAmount - senderTotalOutputAmount - sendSess.amount;
          logger.debug(processSendSession, 'sender fee:', senderFee);
        }

        if (sendResult) {
          const updateResult = await db.send.update({
            where: { id: sendSess.id },
            data: {
              txid: sendResult,
              fee: totalFee,
              senderFee,
            }
          });
  
          logger.info(processSendSession, 'updated session with txid:', sendResult);
          logger.info(processSendSession, 'updated session:', updateResult);
        } else {
          logger.error(processSendSession, 'final response is empty or not a txid');
          // @todo flag it as having an error here perhaps?
        }
      } else {
        logger.error(processSendSession, 'final response is empty or not a psbt');
        // @todo flag it as having an error here perhaps?
        return;
      }
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