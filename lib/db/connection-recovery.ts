/**
 * Evict dead pooled connections after a dropped-connection error — without closing the shared client.
 *
 * Production evidence (2026-11-11/12, /api/task-reminders/dispatch): after an idle stretch the Neon pooler has closed
 * SEVERAL of the warm function's pooled connections at once. The first query fails with P1017, the 250 ms retry
 * draws the next dead connection and fails the same way, and the QStash retry 12 s later can fail again. Prisma drops
 * a connection from its pool when a query on it fails, so the cure is to spend those failures on a trivial probe
 * instead of on the real work: run a cheap read-only probe until one succeeds (a live connection was reached) or the bound is hit.
 * The probe is the caller's own existing read (e.g. the due query with limit 1), so no new use of the client appears.
 *
 * Why not `$disconnect()`: the client is shared by every request in the same warm instance; disconnecting it would
 * fail other requests' in-flight queries. A probe only ever touches connections that are already broken.
 *
 * Bounded, read-only (as the probe is), never throws — the caller's retry decides the outcome.
 */
import { isConnectionError } from "./transient-retry";

export const MAX_PROBES = 6;

/** Returns how many probes ran and whether a live connection answered. */
export async function evictDeadConnections(probe: () => Promise<unknown>, maxProbes = MAX_PROBES): Promise<{ probes: number; live: boolean }> {
  const bound = Math.min(10, Math.max(1, Math.floor(maxProbes)));
  for (let probes = 1; probes <= bound; probes++) {
    try {
      await probe();
      return { probes, live: true };
    } catch (error) {
      if (!isConnectionError(error)) return { probes, live: false };
    }
  }
  return { probes: bound, live: false };
}
