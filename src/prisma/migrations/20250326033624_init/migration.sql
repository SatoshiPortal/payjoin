-- CreateTable
CREATE TABLE "send" (
    "id" SERIAL NOT NULL,
    "bip21" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "txid" TEXT,
    "address" TEXT,
    "fee" BIGINT,
    "callback_url" TEXT,
    "called_back_ts" TIMESTAMP(3),
    "expiry_ts" TIMESTAMP(3),
    "cancelled_ts" TIMESTAMP(3),
    "session" TEXT,
    "confirmed_ts" TIMESTAMP(3),
    "created_ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "send_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receive" (
    "id" SERIAL NOT NULL,
    "bip21" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "txid" TEXT,
    "fallback_tx_hex" TEXT,
    "callback_url" TEXT,
    "called_back_ts" TIMESTAMP(3),
    "expiry_ts" TIMESTAMP(3),
    "cancelled_ts" TIMESTAMP(3),
    "session" TEXT,
    "confirmed_ts" TIMESTAMP(3),
    "created_ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "send_bip21_key" ON "send"("bip21");

-- CreateIndex
CREATE INDEX "send_bip21_idx" ON "send"("bip21");

-- CreateIndex
CREATE INDEX "send_address_idx" ON "send"("address");

-- CreateIndex
CREATE INDEX "send_txid_idx" ON "send"("txid");

-- CreateIndex
CREATE UNIQUE INDEX "receive_bip21_key" ON "receive"("bip21");

-- CreateIndex
CREATE UNIQUE INDEX "receive_address_key" ON "receive"("address");

-- CreateIndex
CREATE INDEX "receive_bip21_idx" ON "receive"("bip21");

-- CreateIndex
CREATE INDEX "receive_address_idx" ON "receive"("address");

-- CreateIndex
CREATE INDEX "receive_txid_idx" ON "receive"("txid");
