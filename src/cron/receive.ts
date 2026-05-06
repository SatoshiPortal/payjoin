import { payjoin } from "payjoin";
import { db } from "../lib/db";
import logger from "../lib/Log2File";
import { Config } from "../config";
import { Receive } from "@prisma/client";
import { lock, cnClient, syncCnClient } from "../lib/globals";
import Utils from "../lib/Utils";
import { arrayBufferToHex, extractFeeFromPsbt, fetchBufferResponse } from "../lib/payjoin";
import { addressCallbackUrl } from "../api/callback/address";
import { ReceiverPersister } from "../lib/persister";

// used to cache and store known (or "seen") inputs
// which are used to determine someone is attempting a probing attack
let knownInputsCache: Map<string, string> = new Map();
let lastCacheUpdateTime = 0;
const CACHE_TTL = 60000; // 1 minute in milliseconds

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

    // populate the known inputs cache
    await getKnownInputsSet().catch(logger.error);

    try {
      const persister = new ReceiverPersister({ id: receiveSess.id, db });
      persister.restore(JSON.parse(receiveSess.session || '[]'));
      const replayResult = payjoin.replayReceiverEventLog(persister);

      const restoredReceiver = replayResult.state();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let receiver: any = restoredReceiver.inner.inner;

      logger.debug(processReceiveSession, 'restored receiver state:', restoredReceiver.tag);

      if (receiver instanceof payjoin.Initialized) {
        logger.debug(processReceiveSession, 'Receiver is in Initialized state');

        const rr = receiver.createPollRequest(receiveSess.ohttpRelay ?? config.OHTTP_RELAYS[0]);
        const responseBuffer = await fetchBufferResponse(rr.request);

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

        const sessionNewInputs = new Set<string>();
        receiver = receiver.checkNoInputsSeenBefore(
          { callback: (outpoint: payjoin.PlainOutPoint) => isKnown(outpoint, receiveSess.bip21!, sessionNewInputs) }
        ).save(persister);

        // save any new "seen" inputs to the database and add to cache
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
          .filter(vout => vout.scriptPubKey.address === receiveSess.address)
          .map((vout) => {
            return [
              vout.n,
              vout.scriptPubKey.hex,
            ] as [number, string];
          });

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
          const { error: addrError, result: addrResult } = await cnClient.getnewaddress({ wallet: config.RECEIVE_WALLET });
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
      const inputs = await availableInputs(config);
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

        // lock utxos using utxosToBeLocked
        const toLock = receiver.utxosToBeLocked();
        logger.debug(processReceiveSession, 'utxos to be locked:', toLock);

        // lock the inputs used in the payjoin tx
        // Note: we might have to be careful with these locks. If the payjoin fails below this point
        // we may end up with "orphand" locks.
        if (toLock && toLock.length > 0) {
          const lockUtxos = toLock.map((utxo) => {
            const { txid, vout } = utxo;
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

        // flush persisted state before sending the proposal so a crash after send can replay correctly
        await persister.flush();

        const rr = receiver.createPostRequest(receiveSess.ohttpRelay ?? config.OHTTP_RELAYS[0]);
        const responseBuffer = await fetchBufferResponse(rr.request);

        // Note: a success response here doesn't mean the sender accepted the PSBT.
        // Fallback tx broadcast is handled separately after a timeout if the payjoin tx is not seen.
        const result = receiver.processResponse(responseBuffer, rr.clientResponse).save(persister);
        logger.debug(processReceiveSession, 'processed proposal response:', result);
        
        const { error: decodedFinalPsbtError, result: decodedFinalPsbtResult } = await cnClient.decodePsbt({ psbt: finalPsbt });
        if (decodedFinalPsbtError || !decodedFinalPsbtResult) {
          logger.error(processReceiveSession, 'failed to decode final psbt:', decodedFinalPsbtError);
        } else {
          let totalFee = 0n, receiverFee = 0n, receiverTotalInputAmount = 0n, receiverTotalOutputAmount = 0n;

          // full fee for the transaction
          totalFee = extractFeeFromPsbt(decodedFinalPsbtResult);
          logger.debug(processReceiveSession, 'total fee:', totalFee);

          // total the amount of all of our inputs
          receiverTotalInputAmount = decodedFinalPsbtResult.inputs.filter((input) => {
            return (
              input.witness_utxo &&
              input.witness_utxo.amount &&
              // this is one our candidate inputs we provided above - i.e. we own it
              inputs.some((possibleInput: InputPairWithMetadata) => {
                logger.debug(processReceiveSession, 'comparing possible input:', possibleInput.scriptPubKey, possibleInput.amount, 'with input:', input.witness_utxo?.scriptPubKey, input.witness_utxo?.amount);
                return possibleInput.scriptPubKey === input.witness_utxo?.scriptPubKey.hex;
              })
            );
          }).reduce((acc, input) => {
            return acc + Utils.btcToSats(input.witness_utxo?.amount || 0);
          }, 0n);
          logger.debug(processReceiveSession, 'total receiver input amount:', receiverTotalInputAmount);

          // get the amount of our output (use effectiveReceiverAddress to handle output substitution)
          receiverTotalOutputAmount = decodedFinalPsbtResult.tx.vout.reduce((acc, output) => {
            if (output.scriptPubKey.address === effectiveReceiverAddress) {
              return acc + Utils.btcToSats(output.value);
            }
            return acc;
          }, 0n);
          logger.debug(processReceiveSession, 'total receiver output amount:', receiverTotalOutputAmount);

          // net amount received = outputs - contributed inputs
          // receiverFee = expected payment - net received (positive means receiver paid fees)
          const netReceived = receiverTotalOutputAmount - receiverTotalInputAmount;
          receiverFee = receiveSess.amount - netReceived;
          logger.debug(processReceiveSession, 'receiver fee:', receiverFee, 'net received:', netReceived);

          // verify net received is close to the expected payment amount
          const calculatedAmount = netReceived;
          let updateAmount = receiveSess.amount;
          const tolerance = 10n;
          const difference = calculatedAmount > receiveSess.amount
            ? calculatedAmount - receiveSess.amount
            : receiveSess.amount - calculatedAmount;

          if (difference > tolerance) {
            logger.error(
              processReceiveSession,
              `net received differs from expected by ${difference} sats (more than ${tolerance} tolerance): ` +
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
        }
      }

    } catch (e) {
      logger.error(processReceiveSession, 'failed to restore session:', e);

      await db.receive.updateMany({
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

function isKnown(outpoint: payjoin.PlainOutPoint, currentBip21: string, newInputs: Set<string>): boolean {
  logger.debug(isKnown, 'checking if outpoint is known:', outpoint);

  const outpointKey = `${outpoint.txid}:${outpoint.vout}`;

  const cachedBip21 = knownInputsCache.get(outpointKey);

  if (cachedBip21 === undefined) {
    // Input has never been seen before
    logger.debug(isKnown, 'outpoint is not known (cache):', outpoint);
    newInputs.add(outpointKey);
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

async function saveKnownInputs(bip21: string, newInputs: Set<string>) {
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
}

async function availableInputs(config: Config): Promise<InputPairWithMetadata[]> {
  const { error: utxosError, result: utxosResult } = await cnClient.listUnspent({ wallet: config.RECEIVE_WALLET });
  if (utxosError || !utxosResult) {
    logger.error(availableInputs, 'failed to list unspent:', utxosError);
    return [];
  }

  logger.debug(availableInputs, 'found utxos:', utxosResult.utxos.length);

  // sort smallest to largest
  const sortedUtxos = [...utxosResult.utxos]
    .filter((utxo) => utxo.confirmations > 0)
    .sort((a, b) => {
      return Number(Utils.btcToSats(a.amount) - Utils.btcToSats(b.amount))
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
logger.warn(availableInputs, 'selected inputs:', inputs);
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