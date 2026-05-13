-- AlterTable
ALTER TABLE "receive" ADD COLUMN IF NOT EXISTS "failed_reason" TEXT;
