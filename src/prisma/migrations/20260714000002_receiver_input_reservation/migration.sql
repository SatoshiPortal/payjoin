-- Receiver input reservation (issue #8): records the outpoint this session
-- contributed to its payjoin proposal, so the wallet lock has a durable owner
-- and can be released when the session reaches a terminal outcome. The unique
-- index is the cross-session/cross-replica synchronization point: at most one
-- receive session can reserve a given outpoint (NULLs are distinct, so
-- unreserved rows don't collide).
ALTER TABLE "receive" ADD COLUMN "reserved_input_txid" TEXT;
ALTER TABLE "receive" ADD COLUMN "reserved_input_vout" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "receive_reserved_input_txid_reserved_input_vout_key" ON "receive"("reserved_input_txid", "reserved_input_vout");
