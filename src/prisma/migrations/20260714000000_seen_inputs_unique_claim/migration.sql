-- Seen-input rows become permanent, uniquely-owned claims (issue #7).
-- Deduplicate (txid, vout) first, keeping the earliest claim (lowest id),
-- so the unique index can be created.
DELETE FROM "seen_inputs" a
USING "seen_inputs" b
WHERE a."txid" = b."txid"
  AND a."vout" = b."vout"
  AND a."id" > b."id";

-- DropIndex: redundant — txid is the leading column of the unique index below
DROP INDEX "seen_inputs_txid_idx";

-- CreateIndex
CREATE UNIQUE INDEX "seen_inputs_txid_vout_key" ON "seen_inputs"("txid", "vout");
