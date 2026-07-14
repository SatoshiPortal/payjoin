-- AlterTable: marks a failed session whose fallback broadcast can never succeed
-- (inputs spent by a conflicting tx / tx already in chain) so the cron stops
-- retrying it, without discarding fallback_tx_hex from the record.
ALTER TABLE "receive" ADD COLUMN "fallback_abandoned_ts" TIMESTAMP(3);
