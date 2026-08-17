import { config } from "../../config";
import { db } from "../../lib/db";
import logger from "../../lib/Log2File";
import Utils from "../../lib/Utils";
import { appendReceiveStatus } from "../../lib/payjoin";
import { lock, cnClient } from "../../lib/globals";
import { Receive } from "@prisma/client";

export function addressCallbackUrl(type: "send" | "receive", address: string, token?: string | null) {
  const baseUrl = `${config.URL_SERVER}:${config.URL_PORT}/${type}/address/${address}`;
  return token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
}

// Authentication itself happens in the findFirst below, which selects the session BY
// its token — so a row that came back for a tokenized callback is already proven. This
// only covers the pre-migration rows, whose watches were registered with no token in
// the callback URL and whose callbacks therefore cannot be authenticated at all: accept
// them just inside their own lifetime. Receive fallbacks are deliberately broadcast
// after expiry, however, so legacy rows with a stored fallback must remain eligible
// until their on-chain outcome is observed (cancelled sessions stay closed).
function legacyTokenlessCallbackIsAcceptable(
  payjoin: { expiryTs: Date | null; fallbackTxHex?: string | null; cancelledTs: Date | null },
  type: "send" | "receive",
): boolean {
  const unexpired = payjoin.expiryTs !== null && payjoin.expiryTs > new Date();
  const awaitingReceiveFallback = type === "receive"
    && payjoin.fallbackTxHex != null
    && payjoin.cancelledTs === null;
  return unexpired || awaitingReceiveFallback;
}

function amountPaidToAddress(
  transaction: { vout: Array<{ value: number; scriptPubKey: { address: string } }> },
  address: string,
): bigint {
  return transaction.vout
    .filter(output => output.scriptPubKey.address === address)
    .reduce((total, output) => total + Utils.btcToSats(output.value), 0n);
}

// The txid stored at proposal time is only a guess (decodepsbt reports the PSBT's
// global unsigned tx, which has every scriptSig emptied — see receive.ts around
// decodedFinalPsbtResult — so it's wrong whenever an input's finalized form needs a
// real scriptSig, e.g. the receiver contributing a P2SH-wrapped coin). A mismatch
// against the real on-chain txid therefore does NOT by itself mean "non-payjoin": if
// our own reserved input has been spent, nothing but our own signed proposal could
// have spent it, so this is genuinely our payjoin under a different real txid.
async function reservedInputWasSpent(payjoin: Receive): Promise<boolean> {
  if (!payjoin.reservedInputTxid || payjoin.reservedInputVout == null) return false;
  const { result } = await cnClient.listUnspent({ wallet: config.RECEIVE_WALLET });
  const stillUnspent = result?.utxos.some(
    u => u.txid === payjoin.reservedInputTxid && u.vout === payjoin.reservedInputVout
  );
  return !stillUnspent;
}

export async function handleAddressCallback(data: any, type: "send" | "receive", token?: string) {
  logger.info(handleAddressCallback, "address callback:", JSON.stringify(data, null, 2));

  // Prisma drops an `undefined` filter rather than matching null, so a body without an
  // address would turn the lookup below into "any pending session" and attribute the
  // callback to an arbitrary one. Fail closed before the address is used as a lock key.
  if (typeof data.address !== "string" || data.address.length === 0) {
    logger.warn(handleAddressCallback, `callback for ${type} has no valid address`);
    return;
  }

  await lock.acquire(data.address, async () => {
    const prismaModel: any = type === "send" ? db.send : db.receive;
    try {
      let payjoin = await prismaModel.findFirst({
        where: {
          address: data.address,
          confirmedTs: null,
          // Tokenized callbacks must select the session by the capability itself,
          // not select an arbitrary same-address row and compare afterward. Send
          // addresses may legitimately be reused by multiple pending sessions.
          callbackToken: token ?? null,
        }
      });

      if (!payjoin) {
        // A pending session exists for this address but the capability did not select
        // it: someone is probing the callback route, and that has to stay separable
        // from the routine case of a callback with nothing left to apply it to (e.g. a
        // second delivery after confirmedTs was already set).
        const pending = await prismaModel.count({ where: { address: data.address, confirmedTs: null } });
        if (pending > 0) {
          logger.warn(handleAddressCallback, `invalid callback token for ${type} address: ${data.address}`);
        } else {
          logger.info(handleAddressCallback, `no pending payjoin ${type} for address: ${data.address}`);
        }
        return;
      }

      // Only reachable for a tokenless (pre-migration) row — see the helper.
      if (!payjoin.callbackToken && !legacyTokenlessCallbackIsAcceptable(payjoin, type)) {
        logger.warn(handleAddressCallback, `expired tokenless callback for ${type} address: ${data.address}`);
        return;
      }

      if (typeof data.txid !== "string") {
        logger.warn(handleAddressCallback, `invalid callback transaction claim for ${type} address: ${data.address}`);
        return;
      }

      const { error: transactionError, result: transaction } = await cnClient.getTransaction(data.txid);
      if (transactionError || !transaction || transaction.txid !== data.txid) {
        logger.warn(handleAddressCallback, `callback transaction not found for ${type} address: ${data.address}`, transactionError);
        return;
      }

      // A transaction that pays this address nothing is the forgery case: an attacker
      // naming some unrelated real txid. Anything that does pay it is a real payment,
      // and from there the two directions diverge:
      //   receive — an underpayment is a payment the operator accepts, so it is logged
      //             and then recorded with the Cyphernode-derived amount and reported on;
      //   send    — a genuine proposal usually pays the payee at least the bip21 amount,
      //             but when the sender offered no fee_contribution and the payee output
      //             is the receiver's only output, a compliant receiver may shave its own
      //             fee rate top-up off that same output rather than off the sender. That
      //             case is already ours: validateAndBroadcastPayjoinPsbt recorded this
      //             exact txid the moment we signed and broadcast it ourselves, so an
      //             underpayment against a txid we don't already recognize is the only
      //             one that must not touch the record.
      // Either way the Cyphernode-derived total is what gets written below, never the claim.
      const paidAmount = amountPaidToAddress(transaction, payjoin.address);
      if (paidAmount === 0n) {
        logger.warn(handleAddressCallback, `callback transaction does not pay ${type} address: ${data.address}`);
        return;
      }
      if (paidAmount < payjoin.amount) {
        logger.warn(handleAddressCallback, `callback transaction underpays ${type} address: ${data.address}: paid ${paidAmount} of ${payjoin.amount}`);
        if (type === "send" && data.txid !== payjoin.txid) return;
      }

      // Cyphernode is authoritative and is what drives confirmedTs below, so the
      // callback's own count carries no authority and a disagreement must not abort:
      // callbacks are acked with 200 before this runs, so cyphernode never retries
      // and a single skewed count would strand the session unconfirmed forever.
      const confirmations = transaction.confirmations ?? 0;
      const claimedConfirmations = Number(data.confirmations);
      if (Number.isFinite(claimedConfirmations) && confirmations < claimedConfirmations) {
        logger.warn(handleAddressCallback, `callback claims ${claimedConfirmations} confirmations, node reports ${confirmations} for ${type} address: ${data.address}`);
      }

      const mismatched = type === "receive" && data.txid !== payjoin.txid;
      const looksLikeOurPayjoin = mismatched && await reservedInputWasSpent(payjoin as Receive);

      if (mismatched && !looksLikeOurPayjoin) {
        let updatedPayjoin: Receive;
        if (payjoin.fallbackTs) {
          // this is a fallback tx
          logger.info(handleAddressCallback, "fallback transaction detected");
          updatedPayjoin = await db.receive.update({
            where: { id: payjoin.id },
            data: {
              amount: paidAmount, // record the amount verified from the transaction outputs
              receiverFee: 0n, // we contribute no fee in a fallback tx
              receiverInAmount: 0n,
              receiverOutAmount: 0n,
            }
          });
        } else {
          // this is a non-payjoin transaction
          logger.info(handleAddressCallback, "non-payjoin transaction detected");
          updatedPayjoin = await db.receive.update({
            where: { id: payjoin.id },
            data: {
              amount: paidAmount,
              receiverFee: 0n, // we contribute no fee in a non-payjoin tx
              receiverInAmount: 0n,
              receiverOutAmount: 0n,
              txid: data.txid,
              nonPayjoinTs: new Date(),
            }
          });
          logger.info(handleAddressCallback, "non-payjoin tx received for session");
        }

        // send the callback data
        if (payjoin.callbackUrl) {
          const postData = Utils.sanitizeResponse(
            appendReceiveStatus(updatedPayjoin as unknown as Parameters<typeof appendReceiveStatus>[0])
          )
          if (await Utils.post(payjoin.callbackUrl, postData)) {
            logger.info(handleAddressCallback, "callback sent to:", payjoin.callbackUrl);
            await db.receive.update({
              where: { id: payjoin.id },
              data: {
                calledBackTs: new Date()
              }
            });
          }
        }

        return;
      }

      // not updating the amount here - it will be different from the actual payjoin amount
      // @todo do we need to store it in a separate field?
      const updateData: any = {
        txid: data.txid,
        fee: Utils.btcToSats(data.fees), // this fee will be the total - but we'll want the split as well
      }
      if (type === "receive") {
        updateData.firstSeenTs = payjoin.firstSeenTs ?? new Date();
      }
      if (confirmations >= 1 && payjoin.confirmedTs === null) {
        updateData.confirmedTs = new Date();
      }

      const updatedPayjoin = await prismaModel.update({
        where: { id: payjoin.id },
        data: updateData
      });
      logger.info(handleAddressCallback, `updated payjoin ${type} record:`, updatedPayjoin);

      // send the callback data
      if (updatedPayjoin.callbackUrl) {
        const postData = Utils.sanitizeResponse(
          appendReceiveStatus(updatedPayjoin as unknown as Parameters<typeof appendReceiveStatus>[0])
        )
        if (await Utils.post(updatedPayjoin.callbackUrl, postData)) {
          logger.info(handleAddressCallback, "callback sent to:", updatedPayjoin.callbackUrl);
          await prismaModel.update({
            where: { id: payjoin.id },
            data: {
              calledBackTs: new Date()
            }
          });
        }
      }

      // stop watching the address if tx is confirmed
      if (updatedPayjoin.confirmedTs) {
        const watchUrl = addressCallbackUrl(type, data.address, payjoin.callbackToken);
        await cnClient.unwatch({
          address: data.address,
          unconfirmedCallbackURL: watchUrl,
          confirmedCallbackURL: watchUrl,
        });
      }
    } catch (e) {
      logger.error(handleAddressCallback, "Failed to handle address callback:", e);
    }
  });
}
