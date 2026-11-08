/**
 * Leads L1.5-b · A2 — the hold clock: how long a held intake receipt has really been waiting, and when it expires.
 * PREPARED, OFF: nothing here runs unless INTAKE_HOLD_CLOCK_ENABLED is exactly "true" (unset everywhere).
 *
 * The clock is per receipt, kept in its non-personal `metadata.holdClock` (no schema change):
 *
 *   { v: 1, ms, at, code, grace, warnedAt }
 *     ms        counted held time (milliseconds) — only ever grows; a change of hold reason never resets it
 *     at        the last look that found the receipt held
 *     code      the hold reason seen at that look
 *     grace     no time is counted before this instant (set when a Dubiz emergency hold ends)
 *     warnedAt  when the advance warning was written (counted time reached HOLD_WARN_MS)
 *
 * At each look that finds the receipt still held (the probe, and the siblings one look settles in bulk):
 *
 *   - the time since the previous look is counted only when BOTH looks found a COUNTING hold (connection paused,
 *     source withdrawn, business being erased), only past `grace`, and at most HOLD_CLOCK_MAX_GAP_MS per look —
 *     a stalled sweep or a period with the clock switched off can only delay an expiry, never hasten it;
 *   - a Dubiz emergency hold (held:emergency_disabled) is never counted and never expires; the first look after it
 *     ends opens a grace of HOLD_GRACE_MS (≥ 48 h) in which nothing is counted either. The grace is a deadline, not
 *     a reset: counted time is kept, and a later emergency only moves the deadline (never shortens one standing);
 *   - the warning is written once, at the look where counted time reaches HOLD_WARN_MS (day 12);
 *   - the receipt expires only when counted time reaches HOLD_EXPIRY_MS (day 14) AND the warning was written at
 *     least HOLD_WARN_LEAD_MS (48 h) before. Expiry settles it as "expired:<reason>" (A1: archived, payload KEPT,
 *     never a failure, never purged).
 *
 * The clock starts at the first look AFTER it is switched on — never backdated from arrival — so switching it on
 * cannot expire anything for 14 days. Nothing here deletes a payload.
 */
import { Prisma } from "@prisma/client";
import { EXPIRED_PREFIX } from "./expired";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Counted held time after which a receipt expires (owner decision: 14 days, cumulative). */
export const HOLD_EXPIRY_MS = 14 * DAY;
/** Counted held time at which the advance warning is written (day 12). */
export const HOLD_WARN_MS = 12 * DAY;
/** The warning must stand at least this long before the receipt may expire. */
export const HOLD_WARN_LEAD_MS = 48 * HOUR;
/** Nothing is counted for this long after a Dubiz emergency hold ends. */
export const HOLD_GRACE_MS = 48 * HOUR;
/** Most one look counts (a hold is looked at every HOLD_RECHECK_MS = 10 min): a longer gap is under-counted. */
export const HOLD_CLOCK_MAX_GAP_MS = 1 * HOUR;

export const HOLD_CLOCK_EMERGENCY = "held:emergency_disabled";
/** The holds whose time counts towards expiry. Not the Dubiz emergency switch. */
export const COUNTING_HOLDS: readonly string[] = ["held:connection_paused", "held:source_disabled", "held:business_inactive"];

export function holdClockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.INTAKE_HOLD_CLOCK_ENABLED === "true";
}

/** The clock runs for a hold (any "held:" code) only when switched on. */
export function holdClockApplies(code: string, env: Record<string, string | undefined> = process.env): boolean {
  return holdClockEnabled(env) && code.startsWith("held:");
}

export function isCountingHold(code: string): boolean {
  return COUNTING_HOLDS.includes(code);
}

/** "held:connection_paused" → "expired:connection_paused". */
export function expiredCodeFor(holdCode: string): string {
  return EXPIRED_PREFIX + holdCode.slice("held:".length);
}

export type HoldClock = { v: 1; ms: number; at: string; code: string; grace: string | null; warnedAt: string | null };

/**
 * The look, in SQL, over a CTE named `picked` with columns ("id", "hc" = the current metadata->'holdClock', read
 * from rows the statement has locked). Yields a CTE body with: id, clock (the new holdClock jsonb), expire, warned
 * (this look wrote the warning). One definition, used for the probe and its siblings alike.
 */
export function holdClockCalcSql(code: string, now: Date): Prisma.Sql {
  const counting = isCountingHold(code);
  const n = Prisma.sql`${now.toISOString()}::timestamptz`;
  return Prisma.sql`
    SELECT p."id",
           jsonb_build_object('v', 1, 'ms', c.ms1, 'at', c.at1, 'code', ${code}::text, 'grace', c.grace1, 'warnedAt', c.warned1) AS clock,
           (${counting}::boolean AND c.ms1 >= ${HOLD_EXPIRY_MS}::bigint
              AND a.warned0 IS NOT NULL AND a.warned0 <= ${n} - make_interval(secs => ${HOLD_WARN_LEAD_MS / 1000}::int)) AS expire,
           (a.warned0 IS NULL AND c.warned1 IS NOT NULL) AS warned
      FROM picked p
     CROSS JOIN LATERAL (
       SELECT COALESCE((p."hc" ->> 'ms')::bigint, 0) AS ms0,
              (p."hc" ->> 'at')::timestamptz AS at0,
              p."hc" ->> 'code' AS code0,
              (p."hc" ->> 'grace')::timestamptz AS grace0,
              (p."hc" ->> 'warnedAt')::timestamptz AS warned0
     ) a
     CROSS JOIN LATERAL (
       SELECT CASE
                WHEN ${counting}::boolean AND a.at0 IS NOT NULL AND a.code0 = ANY(${COUNTING_HOLDS as string[]}::text[])
                THEN GREATEST(0, floor(EXTRACT(EPOCH FROM (
                       LEAST(${n}, a.at0 + make_interval(secs => ${HOLD_CLOCK_MAX_GAP_MS / 1000}::int))
                       - GREATEST(a.at0, COALESCE(a.grace0, a.at0))
                     )) * 1000))::bigint
                ELSE 0
              END AS add
     ) b
     CROSS JOIN LATERAL (
       SELECT a.ms0 + b.add AS ms1,
              GREATEST(COALESCE(a.at0, ${n}), ${n}) AS at1,
              CASE
                WHEN a.code0 = ${HOLD_CLOCK_EMERGENCY}::text AND ${counting}::boolean
                THEN GREATEST(COALESCE(a.grace0, ${n}), ${n} + make_interval(secs => ${HOLD_GRACE_MS / 1000}::int))
                ELSE a.grace0
              END AS grace1,
              COALESCE(a.warned0, CASE WHEN ${counting}::boolean AND a.ms0 + b.add >= ${HOLD_WARN_MS}::bigint THEN ${n} END) AS warned1
     ) c`;
}

/** The metadata with the new clock merged in (every other key kept). */
export function withClockSql(metadataCol: Prisma.Sql, clockCol: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(${metadataCol}, '{}'::jsonb) || jsonb_build_object('holdClock', ${clockCol})`;
}

/**
 * A hydrated receipt's metadata replaces the old one (processor): keep a running clock, so a receipt that is
 * released, fails, and is held again continues its count instead of starting over.
 */
export function keepHoldClock(previous: Prisma.JsonValue | null | undefined, next: Prisma.InputJsonValue | undefined): Prisma.InputJsonValue | undefined {
  if (next === undefined) return next;
  const clock = previous && typeof previous === "object" && !Array.isArray(previous) ? (previous as Record<string, unknown>).holdClock : undefined;
  if (clock === undefined || clock === null) return next;
  if (typeof next !== "object" || next === null || Array.isArray(next)) return next;
  return { ...(next as Record<string, unknown>), holdClock: clock } as Prisma.InputJsonValue;
}
