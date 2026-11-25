/**
 * Run: npx tsx lib/services/appointment/appointments-health.test.ts   (from the repo root)
 *
 * Appointments health (G4) — pure (no database, no network, no clock):
 *   A. evaluation: a clean snapshot is healthy; each check fails on its own and only its own; thresholds at the edge;
 *      malformed counts fail closed;
 *   B. the route answer: 503 / 401 before anything is read; 200 / 500 with check names; a throwing collector → fixed
 *      code, never its message; the body carries counts and check names only;
 *   C. the collector's walk (fake doors): every business, sums, oldest owed / latest evidence, a failing business, the budget;
 *   D. static: the route authenticates only through decideCronAuth, writes nothing, reads no CRON_SECRET itself; the
 *      watchdog workflow follows the protected `cron` environment pattern and is gated off by default.
 */
import fs from "node:fs";
import path from "node:path";

import {
  HEALTH_CHECKS,
  OWED_DELIVERY_LIMIT_MINUTES,
  answerAppointmentsHealth,
  evaluateAppointmentsHealth,
  type AppointmentsHealthSnapshot,
} from "./appointments-health";
import { collectAppointmentsHealth, type CollectDeps } from "./appointments-health.service";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); }
  else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const clean = (o: Partial<AppointmentsHealthSnapshot> = {}): AppointmentsHealthSnapshot => ({
  businessesScanned: 3, businessesFailed: 0, budgetExhausted: false, overlapGuardPresent: true, laneOverlaps: 0,
  staleBookingRequests: 0, staleHolds: 0, oldestOwedDeliveryMinutes: null, failedDeliveries24h: 0, sentDeliveries24h: 0,
  lastSweepEvidenceMinutes: null, ...o,
});
const failing = (s: AppointmentsHealthSnapshot) => evaluateAppointmentsHealth(s).failing.join(",");

async function main() {
  // A. evaluation
  ok("A1 clean snapshot → healthy, nothing failing", evaluateAppointmentsHealth(clean()).ok && failing(clean()) === "");
  const single: [string, Partial<AppointmentsHealthSnapshot>][] = [
    ["overlap_guard", { overlapGuardPresent: false }],
    ["lane_overlaps", { laneOverlaps: 1 }],
    ["booking_sweep_lag", { staleBookingRequests: 2 }],
    ["stale_holds", { staleHolds: 1 }],
    ["owed_delivery_lag", { oldestOwedDeliveryMinutes: OWED_DELIVERY_LIMIT_MINUTES + 1 }],
    ["delivery_outage", { failedDeliveries24h: 4, sentDeliveries24h: 0 }],
    ["scan_incomplete", { businessesFailed: 1 }],
    ["scan_incomplete", { budgetExhausted: true }],
  ];
  for (const [name, o] of single) ok(`A2 ${name} fails alone (${JSON.stringify(o)})`, failing(clean(o)) === name, failing(clean(o)));
  ok("A3 every check name is a declared one", single.every(([n]) => (HEALTH_CHECKS as readonly string[]).includes(n)));
  ok("A4 owed delivery exactly at the limit is healthy", failing(clean({ oldestOwedDeliveryMinutes: OWED_DELIVERY_LIMIT_MINUTES })) === "");
  ok("A5 failures with some sends (dead devices) are not an outage", failing(clean({ failedDeliveries24h: 9, sentDeliveries24h: 1 })) === "");
  ok("A6 old sweep evidence alone never fails (informational)", failing(clean({ lastSweepEvidenceMinutes: 100000 })) === "");
  ok("A7 malformed counts fail closed",
    failing(clean({ laneOverlaps: -1 })) === "lane_overlaps" && failing(clean({ staleHolds: NaN })) === "stale_holds" &&
    failing(clean({ oldestOwedDeliveryMinutes: NaN })) === "owed_delivery_lag" && failing(clean({ sentDeliveries24h: 1.5 })) === "delivery_outage");
  const many = failing(clean({ overlapGuardPresent: false, laneOverlaps: 1, staleBookingRequests: 1 }));
  ok("A8 several failures are all named, in a fixed order", many === "overlap_guard,lane_overlaps,booking_sweep_lag", many);

  // B. the answer
  let reads = 0;
  const collect = (s: AppointmentsHealthSnapshot) => async () => { reads++; return s; };
  const b1 = await answerAppointmentsHealth("NOT_CONFIGURED", collect(clean()));
  ok("B1 NOT_CONFIGURED → 503, nothing read", b1.status === 503 && reads === 0 && JSON.stringify(b1.body) === '{"error":"health_not_configured"}');
  const b2 = await answerAppointmentsHealth("UNAUTHORIZED", collect(clean()));
  ok("B2 UNAUTHORIZED → 401, nothing read", b2.status === 401 && reads === 0 && JSON.stringify(b2.body) === '{"error":"unauthorized"}');
  const b3 = await answerAppointmentsHealth("AUTHORIZED", collect(clean()));
  ok("B3 healthy → 200 ok:true failing:[]", b3.status === 200 && b3.body.ok === true && JSON.stringify(b3.body.failing) === "[]" && reads === 1);
  const b4 = await answerAppointmentsHealth("AUTHORIZED", collect(clean({ laneOverlaps: 2, staleHolds: 1 })));
  ok("B4 unhealthy → 500 naming the checks", b4.status === 500 && b4.body.ok === false && JSON.stringify(b4.body.failing) === '["lane_overlaps","stale_holds"]');
  const b5 = await answerAppointmentsHealth("AUTHORIZED", async () => { throw new Error("secret business 42 detail"); });
  ok("B5 a throwing collector → 500 fixed code, no message", b5.status === 500 && JSON.stringify(b5.body) === '{"ok":false,"error":"health_failed"}');
  const keys = Object.keys((b3.body.counts ?? {}) as object).sort().join(",");
  ok("B6 the body's counts carry no id field", !/businessId|appointmentId|phone|name/i.test(keys) && Object.values(b3.body.counts as object).every((v) => v === null || typeof v === "number" || typeof v === "boolean"), keys);

  // C. the walk
  const now = new Date("2026-11-24T12:00:00.000Z");
  const ids = Array.from({ length: 502 }, (_, i) => i + 1);
  const walkAll = (list: number[]) => async (visit: (id: number) => Promise<void>) => { for (const id of list) await visit(id); };
  const visited: number[] = [];
  const deps = (o: Partial<CollectDeps> = {}): CollectDeps => ({
    staleBookingRequests: async () => 0,
    walkBusinesses: walkAll(ids),
    businessHealth: async (id) => {
      visited.push(id);
      if (id === 7) return { guard: true, overlaps: 1, stale_holds: 2, owed_due_since: new Date("2026-11-24T11:00:00.000Z"), failed_24h: 1, sent_24h: 0, last_expired: "2026-11-24 10:00:00" };
      if (id === 9) return { guard: true, overlaps: 0, stale_holds: 0, owed_due_since: "2026-11-24 11:30:00", failed_24h: 0, sent_24h: 3, last_expired: new Date("2026-11-24T11:50:00.000Z") };
      return { guard: true, overlaps: 0, stale_holds: 0, owed_due_since: null, failed_24h: 0, sent_24h: 0, last_expired: null };
    },
    clock: () => 0,
    ...o,
  });
  const s1 = await collectAppointmentsHealth(now, deps());
  ok("C1 visits every business the walk yields", s1.businessesScanned === 502 && visited.length === 502 && !s1.budgetExhausted);
  ok("C2 sums counts", s1.laneOverlaps === 1 && s1.staleHolds === 2 && s1.failedDeliveries24h === 1 && s1.sentDeliveries24h === 3);
  ok("C3 oldest owed (60 min) and latest evidence (10 min), Date or text", s1.oldestOwedDeliveryMinutes === 60 && s1.lastSweepEvidenceMinutes === 10, JSON.stringify(s1));
  const s2 = await collectAppointmentsHealth(now, deps({ businessHealth: async (id) => { if (id === 3) throw new Error("x"); return { guard: true, overlaps: 0, stale_holds: 0, owed_due_since: null, failed_24h: 0, sent_24h: 0, last_expired: null }; } }));
  ok("C4 a failing business is counted, the others still visited", s2.businessesFailed === 1 && s2.businessesScanned === 501 && failing(s2) === "scan_incomplete");
  let t = 0;
  const s3 = await collectAppointmentsHealth(now, deps({ clock: () => (t += 1000) }), 10_000);
  ok("C5 the time budget stops the walk and marks it incomplete", s3.budgetExhausted && s3.businessesScanned < 20 && failing(s3).split(",").includes("scan_incomplete"), JSON.stringify(s3));
  const s4 = await collectAppointmentsHealth(now, deps({ walkBusinesses: walkAll([]) }));
  ok("C6 no live business → healthy, nothing owed", s4.businessesScanned === 0 && failing(s4) === "" && s4.oldestOwedDeliveryMinutes === null);
  const s5 = await collectAppointmentsHealth(now, deps({ businessHealth: async (id) => ({ guard: id !== 2, overlaps: 0, stale_holds: 0, owed_due_since: null, failed_24h: 0, sent_24h: 0, last_expired: null }) }));
  ok("C7 the guard missing as seen from any business → overlap_guard", failing(s5) === "overlap_guard", failing(s5));
  const s6 = await collectAppointmentsHealth(now, deps({ walkBusinesses: async () => { throw new Error("door down"); } })).then(() => "ok", () => "threw");
  ok("C8 a failing walk is not swallowed (the route answers 500 health_failed)", s6 === "threw");

  // D. static
  const root = process.cwd();
  const strip = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const route = strip("app/api/appointments/health/route.ts");
  ok("D1 route: authority only through decideCronAuth; no CRON_SECRET read", /decideCronAuth\(/.test(route) && !/CRON_SECRET/.test(route));
  const svc = strip("lib/services/appointment/appointments-health.service.ts");
  ok("D2 collector writes nothing (no INSERT/UPDATE/DELETE, no create/update/delete calls)",
    !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(svc) && !/\.(create|update|upsert|delete)(Many)?\(/.test(svc) && !/\$executeRaw/.test(svc));
  ok("D3 no raw access on the bare client: cross-business reads only through the existing doors, the rest inside tenantTx",
    !/from "@\/lib\/prisma"/.test(svc) && !/\bprisma\./.test(svc) && /walkLiveBusinesses/.test(svc) && /duePendingRequests\(/.test(svc) && /tenantTx\(/.test(svc));
  const wf = fs.readFileSync(path.join(root, ".github/workflows/appointments-health.yml"), "utf8");
  ok("D4 watchdog: protected cron environment, main only, gated by a repository variable, red on non-200",
    /environment: cron/.test(wf) && /github\.ref == 'refs\/heads\/main'/.test(wf) && /vars\.APPOINTMENTS_HEALTH_WATCHDOG == 'true'/.test(wf) &&
    /\[ "\$code" = "200" \] \|\| \{/.test(wf) && /secrets\.CRON_SECRET/.test(wf) && /\/api\/appointments\/health/.test(wf));
  const vercel = fs.readFileSync(path.join(root, "vercel.json"), "utf8");
  ok("D5 not scheduled on Vercel (the watchdog is the only caller)", !/appointments\/health/.test(vercel));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
