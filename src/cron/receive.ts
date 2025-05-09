import { InputPairRequest, PayjoinReceiver } from "payjoin-ts";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Receive } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { extractFeeFromPsbt } from "../lib/payjoin";

// used to cache and store known (or "seen") inputs
// which are used to determine someone is attempting a probing attack
let knownInputsCache: Map<string, string> = new Map();
let newInputs: Set<string> = new Set();
let lastCacheUpdateTime = 0;
const CACHE_TTL = 60000; // 1 minute in milliseconds

export async function restoreReceiveSessions(config: Config) {
  logger.info(restoreReceiveSessions, 'restoring receive sessions');

  const { replicaId, totalReplicas } = Utils.replicaInfo();

  // attempt to process all "current" receive sessions
  const allSessions = await db.receive.findMany({
    where: {
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

  for (const receiveSess of sessions) {
    await processReceiveSession(receiveSess, config);
  }

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
  for (const receiveSess of failedSessions) {
    await broadcastFallback(receiveSess, config);
  }
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

    // populate the known inputs cache
    getKnownInputsSet().catch(logger.error);

    try {
      const restoredReceiver = PayjoinReceiver.fromJson(receiveSess.session!);
      const request = restoredReceiver.extractRequest();
      const response = await request.post();

      const uncheckedProposal = await restoredReceiver.processResponse(response, request);
      if (!uncheckedProposal) {
        logger.info(processReceiveSession, 'no proposal found yet');
        return;
      }

      const fallbackTxHex = uncheckedProposal.originalTx();
      logger.info(processReceiveSession, 'fallback tx hex:', fallbackTxHex);

      if (!fallbackTxHex) {
        logger.info(processReceiveSession, 'no fallback tx hex found');
        return;
      }

      const { error: decodeError, result: decodeResult } = await cnClient.decodeRawTransaction({ hex: fallbackTxHex }); 

      if (decodeError || !decodeResult) {
        logger.error(processReceiveSession, 'failed to decode fallback tx:', decodeError);
        return;
      }
      logger.info(processReceiveSession, 'decoded fallback tx:', decodeResult);

      const { error: minFeeError, result: minFeeResult } = await cnClient.getFeeRate({
        confTarget: 6,
      });
      if (minFeeError) {
        logger.error(processReceiveSession, 'failed to get fee rate:', minFeeError);
        return;
      }
      logger.info(processReceiveSession, 'min fee rate:', minFeeResult?.feerate);

      const maybeInputsOwned = await uncheckedProposal.checkBroadcastSuitability(
        Number(minFeeResult!.feerate),
        canBroadcast
      );

      // transaction is suitable for broadcast so let's store it for fallback later if we need to
      receiveSess = await db.receive.update({
        where: { id: receiveSess.id },
        data: {
          fallbackTxHex,
        }
      });

      const maybeInputsSeen = await maybeInputsOwned.checkInputsNotOwned(
        (script: string) => isOwned(script, config)
      );
      logger.debug('checkInputsNotOwned complete');

      const outputsUnknown = await maybeInputsSeen.checkNoInputsSeenBefore(
        (outpoint: string) => isKnown(outpoint, receiveSess.bip21),
      );

      // save any new "seen" inputs to the database and add to cache
      await saveKnownInputs(receiveSess.bip21);

      logger.debug('checkNoInputsSeenBefore complete');
      
      const receiverOutputs = decodeResult.tx.vout
        .filter(vout => vout.scriptPubKey.address === receiveSess.address)
        .map((vout) => {
          return [
            vout.n,
            vout.scriptPubKey.hex,
          ] as [number, string];
        }
      );

      const isReceiverOutput = (script: string): boolean => {
        return receiverOutputs.some((output) => output[1].toString() === script);
      }
      const wantsOutputs = await outputsUnknown.identifyReceiverOutputs(isReceiverOutput);
      logger.debug('identifyReceiverOutputs complete');

      // if (!wantsOutputs.isOutputSubstitutionDisabled()) {
      //   // @todo substitute the outputs - do we need to do that in any cases?
      //   logger.debug(restoreReceiveSessions, 'output substitution allowed');
      // }
      const wantsInputs = wantsOutputs.commitOutputs();
      logger.debug('commitOutputs complete');

      const availableInputs = async () => {
        const { error: utxosError, result: utxosResult } = await cnClient.listUnspent({ wallet: config.RECEIVE_WALLET });
        if (utxosError || !utxosResult) {
          logger.error(processReceiveSession, 'failed to list unspent:', utxosError);
          return [];
        }

        // sort smallest to largest
        const sortedUtxos = [...utxosResult.utxos]
          .filter((utxo) => utxo.confirmations > 0)
          .sort((a, b) => {
            return Number(Utils.btcToSats(a.amount) - Utils.btcToSats(b.amount))
          });

        const inputs: any[] = [];
        for (const utxo of sortedUtxos) {
          const { error: txError, result: txResult } = await cnClient.getTransaction(utxo.txid);
          if (txError || !txResult) {
            logger.error(processReceiveSession, 'failed to get transaction:', txError);
            continue;
          }

          const psbtInput = {
            witnessUtxo: {
              amount: utxo.amount,
              scriptPubKey: utxo.scriptPubKey
            },
          }
          const txIn = { txid: utxo.txid, vout: utxo.vout };

          inputs.push({
            prevout: txIn,
            psbtData: psbtInput
          });

          // limit to 10 inputs to provide to payjoin library
          if (inputs.length >= 20) {
            break;
          }
        }

        return inputs;
      };

      // get apropriate inputs to contribute
      const inputs: Array<InputPairRequest> = await availableInputs();
      logger.debug(processReceiveSession, 'selected inputs:', inputs);
      if (inputs.length === 0) {
        logger.error(processReceiveSession, 'no inputs found to contribute');
        return;
      }
      const provisionalProposal = await wantsInputs.tryContributeInputs(inputs);
      logger.debug('tryContributeInputs complete');

      const { error: maxFeeError, result: maxFeeResult } = await cnClient.getFeeRate({
        confTarget: 1,
      });
      if (maxFeeError) {
        logger.error(processReceiveSession, 'failed to get fee rate:', maxFeeError);
        return;
      }
      logger.info(processReceiveSession, 'max fee rate:', maxFeeResult?.feerate);

      const payjoinProposal = await provisionalProposal.finalizeProposal(
        Number(minFeeResult!.feerate),
        Number(maxFeeResult!.feerate),
        (psbt: string) => walletProcessPsbt(psbt, config),
      );

      logger.debug(processReceiveSession, 'finalized proposal:', payjoinProposal);

      const psbt = payjoinProposal.psbt();
      logger.info(processReceiveSession, 'finalized proposal psbt:', psbt);

      // lock utxos using utxosToBeLocked
      const toLock = await payjoinProposal.utxosToBeLocked();
      logger.debug(processReceiveSession, 'utxos to be locked:', toLock);

      // lock the inputs used in the payjoin tx
      // Note: we might have to be careful with these locks. If the payjoin fails below this point
      // we may end up with "orphand" locks.
      if (toLock && toLock.length > 0) {
        const lockUtxos = toLock.map((utxo) => {
          const [ txid, vout ] = utxo.split(':');
          return {
            txid,
            vout: Number(vout),
          }
        });

        // loop over them and lock individually in case any of them fail
        for (const utxo of lockUtxos) {
          await cnClient.lockUnspent({ utxos: [utxo], wallet: config.RECEIVE_WALLET });
        }
      }

      const proposalRequest = await payjoinProposal.extractV2Req();
      const proposalResponse = await proposalRequest.post();

      // Note: we seem to be getting a success response here even if the sender doesn't like the 
      // PSBT we sent. We will likely need some rules in place to handle broadcasting the fallback tx
      // after a certain amount of time if the payjoin tx is not broadcasted.
      const updatedPayjoin = await payjoinProposal.processRes(proposalResponse, proposalRequest);

      const finalPsbt = updatedPayjoin.psbt();

      let totalFee = 0n, receiverFee = 0n, receiverTotalInputAmount = 0n, receiverTotalOutputAmount = 0n;
      const { error: decodedFinalPsbtError, result: decodedFinalPsbtResult } = await cnClient.decodePsbt({ psbt: finalPsbt });
      if (decodedFinalPsbtError || !decodedFinalPsbtResult) {
        logger.error(processReceiveSession, 'failed to decode final psbt:', decodedFinalPsbtError);
      } else {
        // full fee for the transaction
        totalFee = extractFeeFromPsbt(decodedFinalPsbtResult);
        logger.debug(processReceiveSession, 'total fee:', totalFee);

        // total the amount of all of our inputs
        receiverTotalInputAmount = decodedFinalPsbtResult.inputs.filter((input) => {
          return (
            input.witness_utxo &&
            input.witness_utxo.amount &&
            // this is one our candidate inputs we provided above - i.e. we own it
            inputs.some((possibleInput) => possibleInput.psbtData.witnessUtxo?.scriptPubKey === input.witness_utxo?.scriptPubKey.hex));
        }).reduce((acc, input) => {
          return acc + Utils.btcToSats(input.witness_utxo?.amount || 0);
        }, 0n);
        logger.debug(processReceiveSession, 'total receiver input amount:', receiverTotalInputAmount);

        // get the amount of our output
        receiverTotalOutputAmount = decodedFinalPsbtResult.tx.vout.reduce((acc, output) => {
          if (output.scriptPubKey.address === receiveSess.address) {
            return acc + Utils.btcToSats(output.value);
          }
          return acc;
        }, 0n);
        logger.debug(processReceiveSession, 'total receiver output amount:', receiverTotalOutputAmount);

        // calculate the receiver fee
        const receiverFee = receiverTotalInputAmount - receiverTotalOutputAmount + receiveSess.amount;
        logger.debug(processReceiveSession, 'receiver fee:', receiverFee);
      }

      // double chexk that the sent amount matches the amount we expect
      const calculatedAmount = receiverTotalOutputAmount - receiverTotalInputAmount - receiverFee;
      let updateAmount = receiveSess.amount;
      const tolerance = 10n;
      const difference = calculatedAmount > receiveSess.amount 
        ? calculatedAmount - receiveSess.amount 
        : receiveSess.amount - calculatedAmount;

      if (difference > tolerance) {
        logger.error(
          processReceiveSession, 
          `calculated amount differs from expected by ${difference} sats (more than ${tolerance} tolerance): ` +
          `calculated=${calculatedAmount}, expected=${receiveSess.amount}`
        );
        // set to update the payjoin amount
        updateAmount = calculatedAmount;
      } else if (difference > 0n) {
        // Amounts differ but within tolerance
        logger.info(
          processReceiveSession, 
          `calculated amount differs from expected by ${difference} sats (within ${tolerance} tolerance): ` +
          `calculated=${calculatedAmount}, expected=${receiveSess.amount}`
        );
      }

      const txid = updatedPayjoin.getTxid();
      logger.debug(processReceiveSession, 'updated proposal txid:', txid);
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
          }
        });
        logger.info(processReceiveSession, 'updated session with txid:', txid, receiveSess.id, updateResult);
      }

    } catch (e) {
      logger.error(processReceiveSession, 'failed to restore session:', e);

      await db.receive.update({
        where: { id: receiveSess.id, failedTs: null },
        data: {
          failedTs: new Date(),
        }
      }).catch((e) => {
        logger.error(processReceiveSession, 'failed to update session with failed timestamp:', e);
      });
    }
  });
}

function canBroadcast(tx: string): boolean {
  logger.debug(canBroadcast, 'checking if tx can be broadcast:', tx);
  
  // ensure that the fallback tx can be broadcast
  const { error: acceptError, result: acceptResult } = syncCnClient.syncTestMempoolAccept({
    rawtx: tx,
  });
  
  if (acceptError || !acceptResult) {
    logger.error(canBroadcast, 'failed to test mempool accept:', acceptError);
    return false;
  } else if (!acceptResult[0].allowed) {
    logger.info(canBroadcast, 'tx not suitable for broadcast:', acceptResult);
    return false;
  } else {
    return true;
  }
};

function isOwned(script: string, config: Config): boolean {
  logger.debug(isOwned, 'checking if script is owned:', script);

  const { error: decodeError, result: decodeResult } = syncCnClient.syncDecodeScript(
    script,
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

function isKnown(outpoint: string, currentBip21): boolean {
  logger.debug(isKnown, 'checking if outpoint is known:', outpoint);

  const cachedBip21 = knownInputsCache.get(outpoint);
  
  if (cachedBip21 === undefined) {
    // Input has never been seen before
    logger.debug(isKnown, 'outpoint is not known (cache):', outpoint);
    newInputs.add(outpoint);
    return false;
  }
  
  if (cachedBip21 === currentBip21 || cachedBip21 === '') {
    // Input seen before with same BIP21 or no BIP21 recorded
    logger.debug(isKnown, 'outpoint is known with same BIP21 (cache):', outpoint);
    return false; // Allow it
  }
  
  // Input seen before with different BIP21
  logger.debug(isKnown, 'outpoint is known with DIFFERENT BIP21 (cache):', outpoint, 
    'cached:', cachedBip21, 'current:', currentBip21);
  return true; // Deny it - it was seen with a different BIP21
}

async function getKnownInputsSet(): Promise<Map<string, string>> {
  const now = Date.now();
  
  // If cache is fresh enough, use it
  if (now - lastCacheUpdateTime < CACHE_TTL) {
    return knownInputsCache;
  }
  
  // Otherwise refresh the cache
  try {
    const allSeenInputs = await db.seenInputs.findMany();
    knownInputsCache = new Map(
      allSeenInputs.map(input => [`${input.txid}:${input.vout}`, input.bip21 || ''])
    );
    lastCacheUpdateTime = now;
    logger.info(`Updated known inputs cache with ${knownInputsCache.size} entries`);
  } catch (e) {
    logger.error('Failed to update known inputs cache:', e);
  }
  
  return knownInputsCache;
}

async function saveKnownInputs(bip21: string) {
  logger.debug(saveKnownInputs, 'saving new inputs:', newInputs);
  const newInputsArray = Array.from(newInputs);

  if (newInputsArray.length === 0) {
    logger.debug(saveKnownInputs, 'no new inputs to save');
    return;
  }

  try {
    await db.seenInputs.createMany({
      data: newInputsArray.map((input) => {
        const [txid, vout] = input.split(':');
        return {
          txid,
          vout: Number(vout),
          bip21,
        }
      }),
      skipDuplicates: true,
    });

    logger.debug(saveKnownInputs, 'saved new inputs:', newInputsArray);
    
    // Update the cache with new inputs
    for (const input of newInputs) {
      knownInputsCache.set(input, bip21);
    }
  } catch (e) {
    logger.error(saveKnownInputs, 'failed to save new inputs:', e);
  }

  // Clear the newInputs set
  newInputs.clear();
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

async function broadcastFallback(receiveSess: Receive, config: Config) {
  logger.debug(broadcastFallback, 'broadcasting fallback tx for receiveSess:', receiveSess.id);

  if (!receiveSess.fallbackTxHex) {
    logger.error(broadcastFallback, 'no fallback tx hex found');
    return;
  }

  const { error: sendError, result: sendResult } = await cnClient.sendRawTransaction({
    hex: receiveSess.fallbackTxHex,
    wallet: config.RECEIVE_WALLET,
  });

  if (sendError || !sendResult) {
    logger.error(broadcastFallback, 'failed to broadcast fallback tx:', sendError);
    return;
  }

  logger.info(broadcastFallback, 'broadcasted fallback tx:', sendResult);

  // update the receive session with the txid
  const updatedReceive = await db.receive.update({
    where: { id: receiveSess.id },
    data: {
      txid: sendResult,
      fallbackTs: new Date(),
    }
  });
  logger.info(broadcastFallback, 'updated receive session with txid:', sendResult, updatedReceive.id);
}