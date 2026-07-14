import { db } from "./db";

export interface SeenOutpoint {
  txid: string;
  vout: number;
}

/**
 * A cross-session conflict: one or more outpoints are already claimed by a
 * different session (or by a legacy row with no owner, which conflicts with
 * every session). Nothing was persisted — the whole claim rolled back.
 */
export class SeenInputConflictError extends Error {
  constructor(public readonly conflicts: Set<string>) {
    super(`seen-input conflict: ${[...conflicts].join(", ")}`);
    this.name = "SeenInputConflictError";
  }
}

export function outpointKey(o: { txid: string; vout: number | bigint }): string {
  return `${o.txid}:${Number(o.vout)}`;
}

/**
 * Atomically claim `outpoints` for the session identified by `bip21`
 * (BIP 78 anti-probing defense — see issue #7).
 *
 * Resolves iff every outpoint is (now) owned by this bip21, so an exact
 * retry/resume of the same session is idempotent. Rejects with
 * SeenInputConflictError — rolling back the entire claim — if any outpoint
 * belongs to another session or has a legacy null owner. Any other rejection
 * is a database failure; the caller must fail closed (do not persist the
 * protocol state transition).
 *
 * Concurrency: the createMany (INSERT ... ON CONFLICT DO NOTHING) is the
 * synchronization point. Under READ COMMITTED a competing transaction's
 * insert of the same (txid, vout) blocks on the unique index until this one
 * commits; the loser then skips the insert and sees the winner's committed
 * row in the ownership check → conflict. At most one session can own a
 * given outpoint.
 */
export async function claimSeenInputsForSession(
  bip21: string,
  outpoints: SeenOutpoint[],
): Promise<void> {
  if (outpoints.length === 0) return;

  // Dedupe and sort (txid asc, vout asc) so concurrent multi-input claims
  // acquire unique-index insertion locks in the same order (no deadlocks).
  const unique = [...new Map(outpoints.map((o) => [outpointKey(o), o])).values()].sort(
    (a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout),
  );

  await db.$transaction(async (tx) => {
    await tx.seenInputs.createMany({
      data: unique.map(({ txid, vout }) => ({ txid, vout, bip21 })),
      skipDuplicates: true,
    });

    const rows = await tx.seenInputs.findMany({
      where: { OR: unique.map(({ txid, vout }) => ({ txid, vout })) },
      select: { txid: true, vout: true, bip21: true },
    });
    const owners = new Map(rows.map((r) => [outpointKey(r), r.bip21]));

    const conflicts = new Set<string>();
    for (const o of unique) {
      // A missing row should be impossible right after our insert; treat it
      // as a conflict (fail closed) rather than assume ownership.
      if (owners.get(outpointKey(o)) !== bip21) conflicts.add(outpointKey(o));
    }
    if (conflicts.size > 0) throw new SeenInputConflictError(conflicts);
  });
}
