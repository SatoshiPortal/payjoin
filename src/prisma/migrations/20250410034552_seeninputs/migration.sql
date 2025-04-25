-- CreateTable
CREATE TABLE "seen_inputs" (
    "id" SERIAL NOT NULL,
    "txid" TEXT NOT NULL,
    "vout" INTEGER NOT NULL,
    "bip21" TEXT,
    "created_ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seen_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seen_inputs_txid_idx" ON "seen_inputs"("txid");

-- CreateIndex
CREATE INDEX "seen_inputs_bip21_idx" ON "seen_inputs"("bip21");
