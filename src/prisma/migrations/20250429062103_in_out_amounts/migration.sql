-- AlterTable
ALTER TABLE "receive" ADD COLUMN     "receiver_input_amount" BIGINT,
ADD COLUMN     "receiver_output_amount" BIGINT;

-- AlterTable
ALTER TABLE "send" ADD COLUMN     "sender_input_amount" BIGINT,
ADD COLUMN     "sender_output_amount" BIGINT;
