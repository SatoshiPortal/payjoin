import { InputPairRequest, PayjoinReceiver } from "payjoin-ts";
import { db } from "../lib/db";
import logger from "../lib/Log2File";

export async function restoreReceiveSessions() {
  logger.info(restoreReceiveSessions, 'restoring receive sessions');

  const sessions = await db.receive.findMany({
    where: {
      confirmedTs: null,
      cancelledTs: null,
      expiryTs: {
        gt: new Date()
      }
    }
  });
  logger.info(restoreReceiveSessions, `found ${sessions.length} sessions to restore`);

  for (const receiveSess of sessions) {
    logger.info(restoreReceiveSessions, 'restoring session:', receiveSess);

    try {
      const restoredReceiver = PayjoinReceiver.fromJson(receiveSess.session);
      const request = restoredReceiver.extractRequest();
      const response = await request.post();

      // @todo should processResponse be async?
      const uncheckedProposal = await restoredReceiver.processResponse(response, request);
      logger.info(restoreReceiveSessions, 'proposal:', uncheckedProposal);

      if (!uncheckedProposal) {
        logger.info(restoreReceiveSessions, 'no proposal found yet');
        continue;
      }

      const fallbackTxHex = uncheckedProposal.originalTx();
      logger.info(restoreReceiveSessions, 'fallback tx hex:', fallbackTxHex);

      if (fallbackTxHex) {
        db.receive.update({
          where: { id: receiveSess.id },
          data: {
            fallbackTxHex
          }
        });
      }

      // @todo implement this to actually check if the tx is suitable for broadcast
      const isTxSuitableForBroadcast = (() => fallbackTxHex !== null)();

      console.debug('1. Checking checkBroadcastSuitability');
      const maybeInputsOwned = await uncheckedProposal.checkBroadcastSuitability(
        null, // @todo implement min fee rate - should we just get the current mempool fee rate through cn?
        (tx_hex: string) => {
          console.debug('2. checking if can broadcast tx:', tx_hex);
          console.log('isTxSuitableForBroadcast', isTxSuitableForBroadcast);
          return isTxSuitableForBroadcast; // return false to say NO broadcast
        }
      );
      console.debug('3. broadcast suitability check complete', maybeInputsOwned);


      const maybeInputsSeen = await maybeInputsOwned.checkInputsNotOwned(
        async (script: any) => {
          logger.debug('checkInputsNotOwned script:', script);
          return false
        } // @todo implement this to check if the inputs are owned
      );
      const outputsUnknown = await maybeInputsSeen.checkNoInputsSeenBefore(
        async () => false // @todo implement this to check if the inputs have been seen before
      );
      const wantsOutputs = outputsUnknown.identifyReceiverOutputs(
        async () => true // @todo implement this to check if the outputs are ours
      );
      if (!wantsOutputs.isOutputSubstitutionDisabled()) {
        // @todo substitute the outputs
      }
      const wantsInputs = wantsOutputs.commitOutputs();

      // @todo get apropriate inputs to contribute
      const inputs: Array<InputPairRequest> = [];
      const providionalProposal = wantsInputs.tryContributeInputs(inputs);
      const payjoinProposal = providionalProposal.finalizeProposal(
        async () => true, // @todo implement finalization
        null, // @todo provide minFeerateSatPerVb or null
        100 // @todo set appropriate maxFeerateSatPerVb value
      );
      const psbt = payjoinProposal.psbt();
      logger.info(restoreReceiveSessions, 'finalized proposal psbt:', psbt);

      const proposalRequest = payjoinProposal.extractV2Req();
      const proposalResponse = await proposalRequest.post();

      const updatedPayjoin = payjoinProposal.processRes(proposalResponse, proposalRequest);
    } catch (e) {
      logger.error(restoreReceiveSessions, 'failed to restore session:', e);
    }
  }
}