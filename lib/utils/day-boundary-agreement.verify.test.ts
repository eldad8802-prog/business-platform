/**
 * Day boundaries agree (Daily Tasks spec, milestone A) — the task agenda buckets by the Jerusalem calendar
 * day, and its sources compute "which day is it" with their own helpers. Three of them must name the same day
 * for every instant, or a lead and a supplier payment due "today" would land in different buckets:
 *
 *   jerusalemDayKey   lib/utils/jerusalem-day.ts            — the task engine's day
 *   leadDayKey        lib/services/crm/lead-core.ts         — leads (S13 / S14)
 *   civilDayStart     lib/services/payables/payables-core.ts — supplier payments (S01), as a UTC-midnight date
 *
 * Measured at the edges that break naive code: the first and last millisecond of each day, both 2026 DST
 * transitions (27 March 02:00 → 03:00, 25 October 02:00 → 01:00), the duplicated autumn hour, New Year,
 * a leap day, and every hour of 2026 and 2028.
 *
 * Known exception, NOT covered here and NOT changed: obligation-core.ts `startOfDay` uses the server's local
 * time zone (legacy secretary store). The task engine never calls it; its sources read the ledger port.
 *
 * Pure (no DB, no network, no clock). Run: npx tsx lib/utils/day-boundary-agreement.verify.test.ts
 */
import { addCalendarDays, jerusalemDayKey, jerusalemDayUtcHalfOpen } from "./jerusalem-day";
import { leadDayKey } from "../services/crm/lead-core";
import { civilDayStart } from "../services/payables/payables-core";

let failed = 0;
let checks = 0;
function agree(label: string, instant: Date): void {
  checks += 1;
  const a = jerusalemDayKey(instant);
  const b = leadDayKey(instant);
  const c = civilDayStart(instant).toISOString().slice(0, 10);
  if (a !== b || a !== c) {
    failed += 1;
    console.error(`FAIL: ${label} ${instant.toISOString()} — jerusalemDayKey=${a} leadDayKey=${b} civilDayStart=${c}`);
  }
}
function expectDay(label: string, instant: Date, day: string): void {
  checks += 1;
  if (jerusalemDayKey(instant) !== day) {
    failed += 1;
    console.error(`FAIL: ${label} ${instant.toISOString()} is ${jerusalemDayKey(instant)}, expected ${day}`);
  }
}
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

// The first and last millisecond of special days, and one millisecond on either side.
for (const key of ["2025-12-31", "2026-01-01", "2026-03-26", "2026-03-27", "2026-03-28", "2026-06-15",
                   "2026-10-24", "2026-10-25", "2026-10-26", "2028-02-29", "2028-03-01"]) {
  const { from, toExclusive } = jerusalemDayUtcHalfOpen(key);
  for (const [label, at] of [["start", from], ["start-1ms", ms(from, -1)], ["start+1ms", ms(from, 1)],
                             ["end-1ms", ms(toExclusive, -1)], ["end", toExclusive]] as const) {
    agree(`${key} ${label}`, at);
  }
  expectDay(`${key} first millisecond`, from, key);
  expectDay(`${key} millisecond before`, ms(from, -1), addCalendarDays(key, -1));
  expectDay(`${key} last millisecond`, ms(toExclusive, -1), key);
}

// The transitions themselves (UTC instants), ±1 ms, and every minute of the duplicated autumn hour.
const SPRING = new Date("2026-03-27T00:00:00.000Z"); // 02:00 IST → 03:00 IDT
const AUTUMN = new Date("2026-10-24T23:00:00.000Z"); // 02:00 IDT → 01:00 IST
for (const t of [SPRING, AUTUMN]) for (const d of [-1, 0, 1]) agree(`transition ${t.toISOString()} ${d}ms`, ms(t, d));
for (let m = -60; m <= 60; m += 1) agree(`autumn hour ${m}min`, ms(AUTUMN, m * 60_000));
expectDay("the spring transition is on 27 March", SPRING, "2026-03-27");
expectDay("the autumn transition is on 25 October", AUTUMN, "2026-10-25");

// Every hour of two years (a leap year included), at :00 and :59:59.999.
for (const year of [2026, 2028]) {
  const start = Date.UTC(year, 0, 1) - 3 * 3_600_000;
  const end = Date.UTC(year + 1, 0, 1) + 3 * 3_600_000;
  for (let t = start; t < end; t += 3_600_000) {
    agree(`hour ${year}`, new Date(t));
    agree(`hour-end ${year}`, new Date(t + 3_599_999));
  }
}

console.log(failed === 0 ? `day-boundary agreement: ${checks} checks, all three helpers agree.` : `\n${failed} of ${checks} FAILED`);
process.exit(failed === 0 ? 0 : 1);
