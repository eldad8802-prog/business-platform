/**
 * Evict dead pooled connections after a dropped-connection error — without closing the shared client.
 *
 * Production evidence (2026-11-11/12, /api/task-reminders/dispatch): after an idle stretch the Neon pooler has closed
 * SEVERAL of the warm function's pooled connections at once. The first query fails with P1017, the 250 ms retry
 * draws the next dead connection and fails the same way, and the QStash retry 12 s later can fail again. Prisma drops
 * a connection from its pool when a query on it fails, so the cure is to spend those failures on a trivial probe
 * instead of on the real work: run `SELECT 1` until one succeeds (a live connection was reached) or the bound is hit.
 *
 * Why not `$disconnect()`: the client is shared by every request in the same warm instance; disconnecting it would
 * fail other requests' in-flight queries. A probe only ever touches connections that are already broken.
 *
 * Safe anywhere: read-only, no tenant, no data, bounded. Never throws — the caller's retry decides the outcome.
 */
import { isConnectionError } from "./transient-retry";

export const MAX_PROBES = 6;

export type ProbeClient = { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

/** Returns how many probes ran and whether a live connection answered. */
export async function evictDeadConnections(client: ProbeClient, maxProbes = MAX_PROBES): Promise<{ probes: number; live: boolean }> {
  const bound = Math.min(10, Math.max(1, Math.floor(maxProbes)));
  for (let probes = 1; probes <= bound; probes++) {
    try {
      await client.$queryRaw`SELECT 1`;
      return { probes, live: true };
    } catch (error) {
      if (!isConnectionError(error)) return { probes, live: false };
    }
  }
  return { probes: bound, live: false };
}
