-- AlterTable
ALTER TABLE "receive" ADD COLUMN     "fallback_broadcast_ts" TIMESTAMP(3),
ADD COLUMN     "first_seen_ts" TIMESTAMP(3);
