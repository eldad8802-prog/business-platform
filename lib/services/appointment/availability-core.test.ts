/**
 * Appointments — the availability engine, pure proofs. Run:
 *   npx tsx lib/services/appointment/availability-core.test.ts
 *
 * Wall-clock hours become instants on Israeli calendar days, including both days the clocks change; exceptions
 * replace or cut the weekly hours; slots respect the length, the step, buffers, notice, the horizon and busy time.
 * No database, no clock of its own.
 */
import {
  computeSlots,
  insideAvailability,
  instantOf,
  isDayKey,
  mergeWindows,
  occupiedRange,
  overlaps,
  subtractWindow,
  weekdayOf,
  windowsAsIntervals,
  windowsForDay,
  type SlotQuery,
  type WeeklyRule,
} from "./availability.core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const iso = (d: Date) => d.toISOString();

console.log("— day keys and weekdays");
check("2026-12-01 is a day key", isDayKey("2026-12-01"));
check("2026-02-30 is not", !isDayKey("2026-02-30"));
check("free text is not", !isDayKey("tomorrow"));
eq("2026-12-06 is a Sunday (0)", weekdayOf("2026-12-06"), 0);
eq("2026-12-12 is a Saturday (6)", weekdayOf("2026-12-12"), 6);

console.log("— windows");
eq("touching windows merge", mergeWindows([{ startMinute: 600, endMinute: 720 }, { startMinute: 540, endMinute: 600 }]),
  [{ startMinute: 540, endMinute: 720 }]);
eq("an invalid window is dropped", mergeWindows([{ startMinute: 600, endMinute: 600 }, { startMinute: 700, endMinute: 1500 }]), []);
eq("a lunch break is cut out", subtractWindow([{ startMinute: 540, endMinute: 1020 }], { startMinute: 780, endMinute: 840 }),
  [{ startMinute: 540, endMinute: 780 }, { startMinute: 840, endMinute: 1020 }]);

const weekdays: WeeklyRule[] = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
eq("a Sunday has the weekly hours", windowsForDay("2026-12-06", weekdays, []), [{ startMinute: 540, endMinute: 1020 }]);
eq("a Saturday has none", windowsForDay("2026-12-12", weekdays, []), []);
eq("a whole-day CLOSED exception closes it", windowsForDay("2026-12-06", weekdays, [{ dayKey: "2026-12-06", kind: "CLOSED", startMinute: null, endMinute: null }]), []);
eq("a partial CLOSED exception cuts it",
  windowsForDay("2026-12-06", weekdays, [{ dayKey: "2026-12-06", kind: "CLOSED", startMinute: 540, endMinute: 720 }]),
  [{ startMinute: 720, endMinute: 1020 }]);
eq("OPEN_HOURS replaces the weekly hours (a Friday morning)",
  windowsForDay("2026-12-11", weekdays, [{ dayKey: "2026-12-11", kind: "OPEN_HOURS", startMinute: 480, endMinute: 780 }]),
  [{ startMinute: 480, endMinute: 780 }]);
eq("an exception on another day changes nothing",
  windowsForDay("2026-12-06", weekdays, [{ dayKey: "2026-12-07", kind: "CLOSED", startMinute: null, endMinute: null }]),
  [{ startMinute: 540, endMinute: 1020 }]);
eq("a rule outside its validity does not apply",
  windowsForDay("2026-12-06", [{ weekday: 0, startMinute: 540, endMinute: 600, validFrom: "2027-01-01", validUntil: null }], []), []);

console.log("— Israel time, both clock changes");
// Winter (UTC+2): 09:00 Jerusalem = 07:00Z. Summer (UTC+3): 09:00 Jerusalem = 06:00Z.
eq("09:00 in December is 07:00Z", iso(instantOf("2026-12-06", 540)), "2026-12-06T07:00:00.000Z");
eq("09:00 in July is 06:00Z", iso(instantOf("2026-07-05", 540)), "2026-07-05T06:00:00.000Z");
// Israel 2026: summer time from Friday 27 March 02:00, winter time from Sunday 25 October 02:00.
eq("09:00 on the spring change day (27 Mar 2026) is 06:00Z", iso(instantOf("2026-03-27", 540)), "2026-03-27T06:00:00.000Z");
eq("09:00 on the autumn change day (25 Oct 2026) is 07:00Z", iso(instantOf("2026-10-25", 540)), "2026-10-25T07:00:00.000Z");
eq("minute 1440 is the next midnight", iso(instantOf("2026-12-06", 1440)), iso(instantOf("2026-12-07", 0)));
{
  const [w] = windowsAsIntervals("2026-10-25", [{ startMinute: 0, endMinute: 1440 }]);
  eq("the autumn change day lasts 25 hours", (w.end.getTime() - w.start.getTime()) / 3_600_000, 25);
  const [s] = windowsAsIntervals("2026-03-27", [{ startMinute: 0, endMinute: 1440 }]);
  eq("the spring change day lasts 23 hours", (s.end.getTime() - s.start.getTime()) / 3_600_000, 23);
}

console.log("— overlap and occupied time");
const at = (s: string) => new Date(s);
check("half-open: back to back does not overlap",
  !overlaps({ start: at("2026-12-06T07:00:00Z"), end: at("2026-12-06T08:00:00Z") }, { start: at("2026-12-06T08:00:00Z"), end: at("2026-12-06T09:00:00Z") }));
check("a minute inside does",
  overlaps({ start: at("2026-12-06T07:00:00Z"), end: at("2026-12-06T08:01:00Z") }, { start: at("2026-12-06T08:00:00Z"), end: at("2026-12-06T09:00:00Z") }));
eq("buffers widen the occupied range",
  ((r) => [iso(r.start), iso(r.end)])(occupiedRange(at("2026-12-06T08:00:00Z"), at("2026-12-06T09:00:00Z"), 10, 15)),
  ["2026-12-06T07:50:00.000Z", "2026-12-06T09:15:00.000Z"]);
check("inside the hours", insideAvailability(at("2026-12-06T07:00:00Z"), at("2026-12-06T08:00:00Z"), windowsAsIntervals("2026-12-06", [{ startMinute: 540, endMinute: 1020 }])));
check("past closing is outside", !insideAvailability(at("2026-12-06T14:30:00Z"), at("2026-12-06T15:30:00Z"), windowsAsIntervals("2026-12-06", [{ startMinute: 540, endMinute: 1020 }])));

console.log("— slots");
const base: SlotQuery = {
  fromDay: "2026-12-06", toDay: "2026-12-06", durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  slotStepMinutes: 60, minLeadMinutes: 0, maxAdvanceDays: 60, now: at("2026-12-01T00:00:00Z"),
  rules: [{ weekday: 0, startMinute: 540, endMinute: 720 }], exceptions: [], busy: [],
};
eq("09:00–12:00, one hour, hourly: three slots", computeSlots(base).map((s) => iso(s.startsAt)),
  ["2026-12-06T07:00:00.000Z", "2026-12-06T08:00:00.000Z", "2026-12-06T09:00:00.000Z"]);
eq("a 90-minute service at a 30-minute step fits four times", computeSlots({ ...base, durationMinutes: 90, slotStepMinutes: 30 }).length, 4);
eq("busy 10:00–11:00 takes that slot", computeSlots({ ...base, busy: [{ start: at("2026-12-06T08:00:00Z"), end: at("2026-12-06T09:00:00Z") }] }).map((s) => iso(s.startsAt)),
  ["2026-12-06T07:00:00.000Z", "2026-12-06T09:00:00.000Z"]);
eq("a 15-minute buffer after reaches the next busy hour", computeSlots({ ...base, bufferAfterMinutes: 15, busy: [{ start: at("2026-12-06T09:00:00Z"), end: at("2026-12-06T10:00:00Z") }] }).map((s) => iso(s.startsAt)),
  ["2026-12-06T07:00:00.000Z"]);
eq("minimum notice hides what is too soon", computeSlots({ ...base, now: at("2026-12-06T06:30:00Z"), minLeadMinutes: 60 }).map((s) => iso(s.startsAt)),
  ["2026-12-06T08:00:00.000Z", "2026-12-06T09:00:00.000Z"]);
eq("nothing beyond the horizon", computeSlots({ ...base, now: at("2026-10-01T00:00:00Z"), maxAdvanceDays: 30 }).length, 0);
eq("a closed day gives nothing", computeSlots({ ...base, exceptions: [{ dayKey: "2026-12-06", kind: "CLOSED", startMinute: null, endMinute: null }] }).length, 0);
eq("a range wider than 31 days is refused", computeSlots({ ...base, toDay: "2027-01-06" }).length, 0);
eq("a reversed range is refused", computeSlots({ ...base, fromDay: "2026-12-07" }).length, 0);
{
  const dst = computeSlots({ ...base, fromDay: "2026-10-25", toDay: "2026-10-25", rules: [{ weekday: 0, startMinute: 540, endMinute: 600 }], now: at("2026-10-01T00:00:00Z") });
  eq("on the autumn change day a 09:00 slot is 09:00 Israel time (07:00Z)", dst.map((s) => iso(s.startsAt)), ["2026-10-25T07:00:00.000Z"]);
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
