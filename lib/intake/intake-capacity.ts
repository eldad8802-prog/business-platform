/**
 * Leads L1.5-b · PR-2 — capacity of held / waiting intake receipts: thresholds and their reading (pure).
 *
 * The thresholds are for MONITORING ONLY (owner decision): reaching one never refuses, drops or slows a delivery.
 * They are read by the sweep (server side, once per run per business) — never computed on a user request.
 *
 *   per business  500 · 1,000 · 2,000 held receipts
 *   platform      20,000 held receipts across every business
 */

export const HELD_TIERS = [500, 1000, 2000] as const;
export type HeldTier = 0 | (typeof HELD_TIERS)[number];
export const HELD_GLOBAL_ALERT = 20_000;

/** The highest per-business tier `held` has reached (0 = below the first). */
export function heldTier(held: number): HeldTier {
  let tier: HeldTier = 0;
  for (const t of HELD_TIERS) if (held >= t) tier = t;
  return tier;
}

/** Per connection (business, source, connection reference) — counts only, never an id of a person or a payload. */
export type ConnectionBacklog = {
  sourceKey: string;
  providerAccountRef: string | null;
  /** Waiting on a hold (`held:*`), by reason (`connection_paused`, `emergency_disabled`, `source_disabled`, `business_inactive`). */
  held: number;
  heldByReason: Record<string, number>;
  /** Not on hold, due now (new, or a retry whose time came). */
  due: number;
  /** Not on hold, waiting for a later attempt (a retry on its backoff, a throttle, a credential wait). */
  retrying: number;
  /** Retries exhausted and payload still kept (replayable). */
  deadLetters: number;
  oldestHeldAt: Date | null;
  oldestUnfinishedAt: Date | null;
};

export type BusinessBacklog = {
  connections: ConnectionBacklog[];
  totals: { held: number; due: number; retrying: number; deadLetters: number };
  oldestHeldAt: Date | null;
  /** True when the scan hit its row cap: every count is then a lower bound ("at least"). */
  capped: boolean;
  /** The row cap of the read. When `capped`, a count is shown as at most this, with "+" (the scan reads one row more to know). */
  scanCap?: number;
};

/** Flow over time for one business (sweep only). */
export type BusinessFlow = {
  receivedLastHour: number;
  receivedLastDay: number;
  processedLastHour: number;
  /** Processed in the last hour more than RECOVERY_LAG_MS after arrival — released holds and recovered retries. */
  recoveredLastHour: number;
  capped: boolean;
};

/** A receipt processed this long after it arrived was recovered (a hold released, a retry that succeeded late). */
export const RECOVERY_LAG_MS = 10 * 60 * 1000;

export function totalsOf(connections: ConnectionBacklog[]): BusinessBacklog["totals"] {
  return connections.reduce(
    (t, c) => ({ held: t.held + c.held, due: t.due + c.due, retrying: t.retrying + c.retrying, deadLetters: t.deadLetters + c.deadLetters }),
    { held: 0, due: 0, retrying: 0, deadLetters: 0 }
  );
}

export function oldest(dates: (Date | null)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d < out)) out = d;
  return out;
}

/** A count as the owner reads it: exact, or — when the read hit its cap — at most the cap, followed by "+". */
export function cappedCount(count: number, backlog: Pick<BusinessBacklog, "capped" | "scanCap">): { n: number; plus: boolean } {
  if (!backlog.capped) return { n: count, plus: false };
  return { n: backlog.scanCap !== undefined ? Math.min(count, backlog.scanCap) : count, plus: true };
}
