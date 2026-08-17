-- AlterTable: the sender's signed original ("fallback") tx and the moment we
-- broadcast it ourselves.
--
-- createSender() funds and signs the original with lockUnspents:true, then
-- hands it to the payjoin SDK and relies on the RECEIVER to broadcast it if
-- the payjoin never completes. Receiver wallets do not reliably do this, so
-- the payment silently never happens while the sender's UTXOs stay locked.
--
-- fallback_tx_hex lets the grace-expiry sweep broadcast the original itself
-- instead of merely releasing the locks; fallback_broadcast_ts records that
-- the on-chain outcome is a plain (non-payjoin) payment rather than a payjoin.
ALTER TABLE "send" ADD COLUMN "fallback_tx_hex" TEXT;
ALTER TABLE "send" ADD COLUMN "fallback_broadcast_ts" TIMESTAMP(3);
