-- AlterTable
ALTER TABLE "send" ADD COLUMN "tx_inputs" JSONB,
ADD COLUMN "tx_outputs" JSONB;

-- AlterTable
ALTER TABLE "receive" ADD COLUMN "tx_inputs" JSONB,
ADD COLUMN "tx_outputs" JSONB;
