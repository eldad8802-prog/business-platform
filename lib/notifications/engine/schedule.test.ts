/**
 * The notification engine's schedule (notify/10-schedule — docs/notifications/scheduling.md). No database, no network.
 *
 *   npx tsx lib/notifications/engine/schedule.test.ts
 *
 *  1. vercel.json carries exactly the three entries of schedule.ts (and the seven existing crons unchanged); every
 *     expression fires at its declared cadence; the project stays far under Vercel's per-project cron limit.
 *  2. Overlap by construction: every scheduled route's maxDuration (60 s) is shorter than its interval, the worker's
 *     claim lease (2 min) outlives any run, the sweep keeps its 45 s budget and its per-business try-lock, the digest
 *     its unique dedupe key — so a run never overlaps its own next tick and overlapping deliveries are absorbed.
 *  3. The sweep's stateless rotation (status-sweep.ts rotationOrder / runStatusSweep opts.rotation): consecutive cron
 *     passes start at consecutive slices; with a budget covering one slice per pass, 1,000 businesses are ALL
 *     reached within 5 passes; few businesses ⇒ every pass covers all; ids changing between passes ⇒ nobody starves.
 *  4. DST: with a pass every 15 min (simulated clock), the digest fires exactly ONCE per local day, at 08:00 local,
 *     on the Israeli clock-change days (Fri 2026-03-27 spring forward, Sun 2026-10-25 fall back) and on a normal day,
 *     for two time zones (Asia/Jerusalem, Europe/London — whose own change days are covered too); a digest minute
 *     inside the skipped hour fires once at the first pass after it, inside the repeated hour once; a minute off
 *     the quarter hour (08:05) fires at the next pass (08:15).
 */
import fs from "node:fs";
import path from "node:path";

import { digestMoment, localMinuteOfDay } from "../notification-time";
import { rotationOrder, runStatusSweep, STATUS_SWEEP_DEFAULT_BUDGET_MS, type StatusSweepDeps } from "../producers/status-sweep";
import { LEASE_MS } from "./push-worker";
import {
  cronMinutes, DIGEST_SCHEDULE, maxGapMinutes, NOTIFICATION_ROUTE_MAX_DURATION_S, NOTIFICATION_SCHEDULES, PUSH_WORKER_SCHEDULE,
  STATUS_SWEEP_CADENCE_MS, STATUS_SWEEP_SCHEDULE,
} from "./schedule";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function main() {
  console.log("1. vercel.json");
  const crons = (JSON.parse(read("vercel.json")) as { crons?: { path: string; schedule: string }[] }).crons ?? [];
  const mine = crons.filter((c) => c.path.startsWith("/api/notifications/"));
  ok("exactly the three notification entries, as schedule.ts declares them (no query string: the sweep's rotation mode)",
    mine.length === 3 && NOTIFICATION_SCHEDULES.every((s) => mine.some((c) => c.path === s.path && c.schedule === s.schedule)), mine);
  const EXISTING = [
    ["/api/payments/reconciliation", "40 2 * * *"], ["/api/payments/settlement-recovery", "0 3 * * *"], ["/api/intake/sweep", "20 3 * * *"],
    ["/api/transactional-email/sweep", "*/10 * * * *"], ["/api/accountant/sweep", "30 * * * *"], ["/api/accountant/monitor", "50 * * * *"],
    ["/api/appointments/booking/sweep", "*/10 * * * *"],
  ];
  ok("the seven existing crons are unchanged and still first, in order", JSON.stringify(crons.slice(0, 7).map((c) => [c.path, c.schedule])) === JSON.stringify(EXISTING), crons);
  ok("10 cron entries in all — far under Vercel's per-project limit (Pro: 40)", crons.length === 10, crons.length);
  for (const s of NOTIFICATION_SCHEDULES) {
    const minutes = cronMinutes(s.schedule);
    ok(`${s.path}: "${s.schedule}" fires every ${s.cadenceMinutes} min (largest gap), every hour`, minutes !== null && maxGapMinutes(minutes) === s.cadenceMinutes, minutes);
  }
  const sweepMin = cronMinutes(STATUS_SWEEP_SCHEDULE.schedule)!;
  const digestMin = cronMinutes(DIGEST_SCHEDULE.schedule)!;
  ok("the sweep never starts on the same minute as the digest (off the quarter hour)", sweepMin.every((m) => !digestMin.includes(m)));
  ok("the digest runs on the quarter hour (08:00 is a tick in every time zone with a whole / half-hour offset)", JSON.stringify(digestMin) === "[0,15,30,45]");

  console.log("2. overlap by construction");
  for (const s of NOTIFICATION_SCHEDULES) {
    const c = code(s.route);
    const m = /export const maxDuration = (\d+);/.exec(c);
    ok(`${s.route}: maxDuration ${m?.[1]} s < its ${s.cadenceMinutes} min interval — Vercel ends a run before the next tick`,
      m !== null && Number(m[1]) === NOTIFICATION_ROUTE_MAX_DURATION_S && Number(m[1]) < s.cadenceMinutes * 60);
    ok(`${s.route}: CRON_SECRET through decideCronAuth (a GET is what Vercel cron sends)`, /decideCronAuth\(req\.headers\.get\("authorization"\)\)/.test(c) && /export async function GET/.test(c));
  }
  ok(`the worker's claim lease (${LEASE_MS / 1000} s) outlives any run (${NOTIFICATION_ROUTE_MAX_DURATION_S} s): a live run's claim never lapses under it`,
    LEASE_MS > NOTIFICATION_ROUTE_MAX_DURATION_S * 1000);
  ok(`…and is shorter than the worker's interval (${PUSH_WORKER_SCHEDULE.cadenceMinutes} min): a crashed run's rows are retried by the next pass`,
    LEASE_MS <= PUSH_WORKER_SCHEDULE.cadenceMinutes * 60_000);
  ok("the worker claims with a conditional UPDATE on a free lease (one winner)",
    /updateMany\(\{[\s\S]{0,200}leaseUntil: null \}, \{ leaseUntil: \{ lt: now \} \}[\s\S]{0,200}data: \{ leaseUntil: lease \}/.test(code("lib/notifications/engine/push-worker.ts")));
  ok("the sweep's state producers run behind a per-business pg_try_advisory_xact_lock",
    /pg_try_advisory_xact_lock\(\$\{SWEEP_LOCK_NAMESPACE\}::int, \$\{businessId\}::int\)/.test(code("lib/notifications/producers/state-producers.ts")));
  ok(`the sweep's budget (${STATUS_SWEEP_DEFAULT_BUDGET_MS / 1000} s, route 45 s) leaves headroom under maxDuration`, /BUDGET_MS = 45_000/.test(code(STATUS_SWEEP_SCHEDULE.route)) && 45_000 < NOTIFICATION_ROUTE_MAX_DURATION_S * 1000);
  ok("the digest's dedupe key is per user per local day (the database's unique key makes a second digest impossible)",
    /digest:u\$\{userId\}:\$\{dayKey\}/.test(code("lib/notifications/engine/digest.ts")));
  ok("the digest route runs the rotation under a 40 s budget, leaving its worker pass room inside maxDuration",
    /runDailyDigest\(now, \{ budgetMs: BUDGET_MS, rotation: \{ cadenceMs: DIGEST_CADENCE_MS \} \}\)/.test(code(DIGEST_SCHEDULE.route)) && /BUDGET_MS = 40_000/.test(code(DIGEST_SCHEDULE.route)));
  ok("no new client and no session-level lock in the scheduled routes (transaction-scoped locks only, inside the engine)",
    NOTIFICATION_SCHEDULES.every((s) => !/new PrismaClient|pg_advisory_lock\(|pg_try_advisory_lock\(/.test(code(s.route))));

  console.log("3. the sweep's stateless rotation");
  const ids = Array.from({ length: 1000 }, (_, i) => 5 + i * 3);
  const base = new Date("2026-12-01T10:07:00Z");
  const tick = (k: number) => new Date(base.getTime() + k * STATUS_SWEEP_CADENCE_MS);
  const r0 = rotationOrder(ids, tick(0), STATUS_SWEEP_CADENCE_MS, 200);
  const r1 = rotationOrder(ids, tick(1), STATUS_SWEEP_CADENCE_MS, 200);
  ok("1,000 businesses ⇒ 5 groups (id mod 5) of 200; consecutive passes start at consecutive groups; each order is a full permutation",
    r0.parts === 5 && r1.startSlice === (r0.startSlice + 1) % 5 && new Set(r0.order).size === 1000 && r0.order.slice(0, 200).every((b) => b % 5 === r0.startSlice) && r1.order.slice(0, 200).every((b) => b % 5 === r1.startSlice), [r0.parts, r0.startSlice, r1.startSlice]);
  const few = rotationOrder(ids.slice(0, 150), tick(3), STATUS_SWEEP_CADENCE_MS, 200);
  ok("150 businesses ⇒ one slice, every pass starts at the first", few.parts === 1 && few.startSlice === 0 && few.order[0] === ids[0]);

  // runStatusSweep in rotation mode, a fake clock: 10 ms per business, pool 2, budget 2,000 ms ⇒ 200 businesses a pass.
  const visit = async (live: number[], now: Date) => {
    const seen: number[] = [];
    let t = 0;
    const deps: Partial<StatusSweepDeps> = {
      liveBusinesses: async (after, limit) => live.filter((b) => b > after).slice(0, limit),
      gates: async (b) => { seen.push(b); t += 10; return { engineOn: false } as never; },
      clock: () => t,
    };
    const rep = await runStatusSweep(now, { deps, budgetMs: 2_000, concurrency: 2, quiet: true, rotation: { cadenceMs: STATUS_SWEEP_CADENCE_MS, slice: 200 } });
    return { seen, rep };
  };
  const covered = new Set<number>();
  const lastSeen = new Map<number, number>();
  let maxWait = 0;
  for (let k = 0; k < 10; k++) {
    const { seen } = await visit(ids, tick(k));
    for (const b of seen) {
      if (lastSeen.has(b)) maxWait = Math.max(maxWait, k - lastSeen.get(b)!);
      lastSeen.set(b, k);
      if (k < 5) covered.add(b);
    }
  }
  const first = await visit(ids, tick(0));
  ok("a budget for 200 a pass: each pass sweeps exactly its group of 200; the report says so",
    first.seen.length === 200 && first.seen.every((b) => b % 5 === first.rep.rotation!.startSlice) && first.rep.rotation?.covered === 200 && first.rep.rotation.total === 1000 && first.rep.nextAfter === null, first.rep.rotation);
  ok("ALL 1,000 businesses reached within 5 consecutive passes (75 min at 15 min)", covered.size === 1000, covered.size);
  ok("…and no business waits more than 5 passes between two sweeps", maxWait === 5, maxWait);
  const big = await visit(ids, tick(2));
  const roomy = await (async () => {
    const seen: number[] = [];
    const deps: Partial<StatusSweepDeps> = { liveBusinesses: async (after, limit) => ids.filter((b) => b > after).slice(0, limit), gates: async (b) => { seen.push(b); return { engineOn: false } as never; }, clock: () => 0 };
    await runStatusSweep(tick(2), { deps, budgetMs: 2_000, quiet: true, rotation: { cadenceMs: STATUS_SWEEP_CADENCE_MS, slice: 200 } });
    return seen;
  })();
  ok("a pass with budget left keeps going around: with time for everyone it covers all 1,000, once each", roomy.length === 1000 && new Set(roomy).size === 1000 && big.seen.length === 200);
  // Businesses added / removed between passes: nobody starves.
  const churn = new Set<number>();
  for (let k = 0; k < 10; k++) {
    const live = ids.filter((_b, i) => !(k >= 2 && i % 97 === 0)).concat(k >= 3 ? [5_000, 5_003] : []); // 11 removed from pass 2, 2 added from pass 3
    for (const b of (await visit(live, tick(k))).seen) churn.add(b);
  }
  ok("ids added / removed (two groups now one over the budget): every live business still reached within 2 cycles (10 passes), the new ones too", ids.filter((_b, i) => i % 97 !== 0).every((b) => churn.has(b)) && churn.has(5_000) && churn.has(5_003), churn.size);

  console.log("4. DST — the digest at a 15-minute cadence");
  const DIGEST_MINUTE = 8 * 60;
  /** Passes every 15 min across [fromUtc, toUtc); returns the instants a digest was written per local day key. */
  const simulate = (tz: string, fromUtc: string, toUtc: string, minute = DIGEST_MINUTE) => {
    const sent = new Map<string, Date[]>();
    const done = new Set<string>();
    for (let t = new Date(fromUtc).getTime(); t < new Date(toUtc).getTime(); t += 15 * 60_000) {
      const now = new Date(t);
      const m = digestMoment(now, tz, minute);
      if (m.due && !done.has(m.dayKey)) {  // the dedupe key: one digest per user per local day
        done.add(m.dayKey);
        sent.set(m.dayKey, [...(sent.get(m.dayKey) ?? []), now]);
      }
    }
    return sent;
  };
  const days: [string, string][] = [
    ["Asia/Jerusalem", "2026-03-27"], ["Asia/Jerusalem", "2026-10-25"], ["Asia/Jerusalem", "2026-06-15"],
    ["Europe/London", "2026-03-27"], ["Europe/London", "2026-10-25"], ["Europe/London", "2026-06-15"],
    ["Europe/London", "2026-03-29"],
  ];
  for (const [tz, day] of days) {
    const d = new Date(`${day}T00:00:00Z`).getTime();
    const sent = simulate(tz, new Date(d - 36 * 3600_000).toISOString(), new Date(d + 36 * 3600_000).toISOString());
    const fires = sent.get(day) ?? [];
    ok(`${tz} ${day}: exactly one digest, at 08:00 local`, fires.length === 1 && localMinuteOfDay(fires[0]!, tz) === DIGEST_MINUTE,
      fires.map((f) => [f.toISOString(), localMinuteOfDay(f, tz)]));
    ok(`${tz} ${day}: …and one on each neighbouring day (none skipped, none doubled)`,
      [...sent.entries()].filter(([k]) => k !== day && sent.get(k)!.length !== 1).length === 0 && sent.size >= 2, [...sent.keys()]);
  }
  // Israel springs forward Fri 2026-03-27 02:00 → 03:00; falls back Sun 2026-10-25 02:00 → 01:00.
  const skipped = simulate("Asia/Jerusalem", "2026-03-26T12:00:00Z", "2026-03-27T12:00:00Z", 2 * 60 + 30).get("2026-03-27") ?? [];
  ok("a digest minute inside the skipped hour (02:30 on 03-27) fires once, at the first pass after it (03:00 local)",
    skipped.length === 1 && localMinuteOfDay(skipped[0]!, "Asia/Jerusalem") === 180, skipped.map((f) => f.toISOString()));
  const repeated = simulate("Asia/Jerusalem", "2026-10-24T12:00:00Z", "2026-10-25T12:00:00Z", 60 + 30).get("2026-10-25") ?? [];
  ok("a digest minute inside the repeated hour (01:30 on 10-25) fires once (its first occurrence)",
    repeated.length === 1 && repeated[0]!.toISOString() === "2026-10-24T22:30:00.000Z", repeated.map((f) => f.toISOString()));
  const off = simulate("Asia/Jerusalem", "2026-06-14T12:00:00Z", "2026-06-15T12:00:00Z", 8 * 60 + 5).get("2026-06-15") ?? [];
  ok("a digest minute off the quarter hour (08:05) fires at the next pass, 08:15 local (≤ 15 min late)",
    off.length === 1 && localMinuteOfDay(off[0]!, "Asia/Jerusalem") === 8 * 60 + 15);

  console.log(`\nschedule: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
