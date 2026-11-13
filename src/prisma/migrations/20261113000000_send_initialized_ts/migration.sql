ALTER TABLE "send" ADD COLUMN "initialized_ts" TIMESTAMP(3);

-- A stored session/fallback does not prove the old send API succeeded.
-- Backfill only transactions already broadcast; pending legacy sends require
-- explicit review before they may be enabled. Do not deploy with old workers running.
UPDATE "send" SET "initialized_ts" = "created_ts" WHERE "txid" IS NOT NULL;
