-- AlterTable
ALTER TABLE "receive" ADD COLUMN     "receiver_fee" BIGINT;

-- AlterTable
ALTER TABLE "send" ADD COLUMN     "sender_fee" BIGINT;
