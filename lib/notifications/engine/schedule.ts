/**
 * The notification engine's schedule — the ONE place the cadences live (docs/notifications/scheduling.md).
 * PURE, no I/O. vercel.json carries the same three entries; lib/notifications/engine/schedule.test.ts pins that they
 * agree, that every run is killed (maxDuration) long before its next tick, and that a worker lease outlives any run.
 *
 *   status sweep  every 15 min (minutes 7, 22, 37, 52 — off the quarter hour, away from the digest), the stateless
 *                 rotation over every live business (status-sweep.ts rotationOrder) under the 45 s budget;
 *   push worker   every 5 min — the backstop behind the after()-response trigger; owed pushes whose nextAttemptAt
 *                 has come (quiet-hours ends, retries, and — notify/9 — appointment reminders) leave within 5 min;
 *   daily digest  every 15 min (on the quarter hour) — each pass decides per business / user whether the local clock
 *                 has reached the digest minute (default 08:00) and no digest exists yet that local day (the dedupe
 *                 key `digest:u<userId>:<YYYY-MM-DD>` makes a second one impossible).
 *
 * Overlap: a run cannot outlive its interval — Vercel ends a function at maxDuration (60 s) and the shortest cadence
 * is 5 min. Two runs of the same route can still overlap (Vercel may deliver a cron event twice; the after() trigger
 * and the digest's own worker pass run beside the cron worker), and each route is safe under that: the worker's
 * conditional-UPDATE claim with a 2 min lease (one winner per owed row; the lease outlives the 60 s run, so a live
 * run's claim never expires under it), the sweep's per-business pg_try_advisory_xact_lock around the state producers
 * plus the writer's / notify()'s unique-key claims, and the digest's unique dedupe key per user per local day.
 */
export const NOTIFICATION_ROUTE_MAX_DURATION_S = 60;

export type NotificationSchedule = {
  /** The cron path (vercel.json `path`). */
  path: string;
  /** The cron expression (vercel.json `schedule`, UTC). */
  schedule: string;
  /** The interval between two ticks, minutes. */
  cadenceMinutes: number;
  /** The route file. */
  route: string;
};

export const STATUS_SWEEP_SCHEDULE: NotificationSchedule = {
  path: "/api/notifications/status-sweep",
  schedule: "7,22,37,52 * * * *",
  cadenceMinutes: 15,
  route: "app/api/notifications/status-sweep/route.ts",
};

export const PUSH_WORKER_SCHEDULE: NotificationSchedule = {
  path: "/api/notifications/worker",
  schedule: "*/5 * * * *",
  cadenceMinutes: 5,
  route: "app/api/notifications/worker/route.ts",
};

export const DIGEST_SCHEDULE: NotificationSchedule = {
  path: "/api/notifications/digest",
  schedule: "*/15 * * * *",
  cadenceMinutes: 15,
  route: "app/api/notifications/digest/route.ts",
};

export const NOTIFICATION_SCHEDULES: readonly NotificationSchedule[] = [STATUS_SWEEP_SCHEDULE, PUSH_WORKER_SCHEDULE, DIGEST_SCHEDULE];

/**
 * Businesses per slice of the scheduled pass's rotation. A pass's 45 s budget covers ≈ 410 businesses at pool 2 in the
 * lab's steady state (109 ms each, docs/notifications/sweep-performance.md) and ≈ 215 with a hosted database's ~2 ms
 * round trip per statement — so a slice of 200 is what one pass is sure to finish (docs/notifications/scheduling.md).
 */
export const STATUS_SWEEP_SLICE = 200;

/**
 * Pure: the scheduled pass's walk order — STATELESS rotation, no cursor stored anywhere (no schema change). The live
 * businesses are split into `parts` = ceil(n / slice) groups BY ID (id mod parts — a business's group does not move
 * when others are added or removed); the pass at `now` walks group floor(now / cadence) mod parts first, then the
 * following groups, wrapping around — within a group ascending ids on even cycles, descending on odd ones (a cycle =
 * `parts` passes), so a group that outgrows one pass's budget loses a different end each cycle, never the same tail
 * forever. Consecutive cron passes start at consecutive groups; a pass with budget left simply continues around (with
 * few businesses every pass covers all of them). Every business is reached within `parts` passes while a group fits a
 * pass's budget, and within 2 × `parts` while it fits twice.
 */
export function rotationOrder(ids: readonly number[], now: Date, cadenceMs: number, slice: number = STATUS_SWEEP_SLICE): { order: number[]; parts: number; startSlice: number } {
  const size = Math.max(1, Math.trunc(slice));
  const parts = Math.max(1, Math.ceil(ids.length / size));
  const startSlice = parts === 1 ? 0 : Math.floor(now.getTime() / Math.max(1, cadenceMs)) % parts;
  const rank = (id: number) => (((id % parts) - startSlice) + parts) % parts;
  const dir = parts === 1 || Math.floor(now.getTime() / Math.max(1, cadenceMs) / parts) % 2 === 0 ? 1 : -1;
  const order = [...ids].sort((a, b) => rank(a) - rank(b) || dir * (a - b));
  return { order, parts, startSlice };
}

/** The digest's rotation advances one group per tick of its own cadence. */
export const DIGEST_CADENCE_MS = DIGEST_SCHEDULE.cadenceMinutes * 60_000;

/** The sweep's rotation advances one slice per tick of its own cadence. */
export const STATUS_SWEEP_CADENCE_MS = STATUS_SWEEP_SCHEDULE.cadenceMinutes * 60_000;

/**
 * Pure: the minutes of the hour a simple cron minute field fires on ("*", "*\/n", "a,b,c", "n"); null for anything
 * else (ranges, names — not used here).
 */
export function cronMinutes(schedule: string): number[] | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(1).some((p) => p !== "*")) return null;
  const m = parts[0]!;
  if (m === "*") return Array.from({ length: 60 }, (_, i) => i);
  const step = /^\*\/(\d{1,2})$/.exec(m);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 59 ? Array.from({ length: Math.ceil(60 / n) }, (_, i) => i * n) : null;
  }
  if (/^\d{1,2}(,\d{1,2})*$/.test(m)) {
    const list = m.split(",").map(Number);
    return list.every((x) => x >= 0 && x <= 59) ? [...new Set(list)].sort((a, b) => a - b) : null;
  }
  return null;
}

/** Pure: the largest gap between two consecutive firings of an hourly-repeating minute list (wrapping the hour). */
export function maxGapMinutes(minutes: readonly number[]): number {
  if (minutes.length === 0) return Infinity;
  let gap = 0;
  for (let i = 0; i < minutes.length; i++) {
    const next = i + 1 < minutes.length ? minutes[i + 1]! : minutes[0]! + 60;
    gap = Math.max(gap, next - minutes[i]!);
  }
  return gap;
}
