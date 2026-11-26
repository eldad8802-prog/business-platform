/**
 * Appointments — the availability engine, pure proofs. Run:
 *   npx tsx lib/services/appointment/availability-core.test.ts
 *
 * Wall-clock hours become instants on Israeli calendar days, including both days the clocks change; exceptions
 * replace or cut the weekly hours; slots respect the length, the step, buffers, notice, the horizon and busy time.
 * No database, no clock of its own.
 */
import {
  appointmentsOutside,
  computeSlots,
  effectiveEnd,
  intersectWindows,
  isRepeatedWallClock,
  laneWindowsForDay,
  openStretches,
  UNTIMED_DEFAULT_MINUTES,
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
import { openingHoursText } from "./opening-hours-text";

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


// ── 2026-11-24: engine correctness (G17, G20, G21, G22, G25, G19 text) ─────────────────────────────────
console.log("— G17: a night across midnight");
{
  // Tue 2026-12-08 20:00–24:00 + Wed 00:00–02:00 (winter, UTC+2): 20:00 = 18:00Z, 02:00 Wed = 00:00Z Wed.
  const night: WeeklyRule[] = [{ weekday: 2, startMinute: 1200, endMinute: 1440 }, { weekday: 3, startMinute: 0, endMinute: 120 }];
  const stretches = openStretches("2026-12-08", "2026-12-08", (d) => windowsForDay(d, night, []));
  eq("the two rules are one stretch, 20:00 Tue → 02:00 Wed", stretches.filter((w) => iso(w.start) === "2026-12-08T18:00:00.000Z").map((w) => iso(w.end)), ["2026-12-09T00:00:00.000Z"]);
  const q: SlotQuery = { ...base, fromDay: "2026-12-08", toDay: "2026-12-08", durationMinutes: 120, slotStepMinutes: 60, rules: night };
  eq("a 120-minute service is offered at 20:00, 21:00, 22:00, 23:00 (23:00 runs to 01:00 Wed)", computeSlots(q).map((x) => iso(x.startsAt)),
    ["2026-12-08T18:00:00.000Z", "2026-12-08T19:00:00.000Z", "2026-12-08T20:00:00.000Z", "2026-12-08T21:00:00.000Z"]);
  eq("…and from the Wednesday side only 00:00 fits (it starts on Wednesday)", computeSlots({ ...q, fromDay: "2026-12-09", toDay: "2026-12-09" }).map((x) => iso(x.startsAt)),
    ["2026-12-08T22:00:00.000Z"]);
  eq("…a Wednesday closure cuts the night's tail", computeSlots({ ...q, exceptions: [{ dayKey: "2026-12-09", kind: "CLOSED", startMinute: null, endMinute: null }] }).map((x) => iso(x.startsAt)),
    ["2026-12-08T18:00:00.000Z", "2026-12-08T19:00:00.000Z", "2026-12-08T20:00:00.000Z"]);
  check("inside the hours across midnight (23:00–01:00)", insideAvailability(at("2026-12-08T21:00:00Z"), at("2026-12-08T23:00:00Z"), stretches));
  check("…but not past 02:00", !insideAvailability(at("2026-12-08T22:00:00Z"), at("2026-12-09T00:30:00Z"), stretches));
  check("a day ending 24:00 with no next-morning rule does not reach past midnight", !insideAvailability(at("2026-12-08T21:00:00Z"), at("2026-12-08T23:00:00Z"),
    openStretches("2026-12-08", "2026-12-08", (d) => windowsForDay(d, [night[0]], []))));
}

console.log("— G21: special days per lane");
{
  const biz = { rules: weekdays, exceptions: [{ dayKey: "2026-12-11", kind: "OPEN_HOURS" as const, startMinute: 480, endMinute: 780 }] }; // Fri 08:00–13:00
  const own = { rules: [{ weekday: 5, startMinute: 600, endMinute: 960 }], exceptions: [] }; // staff: Fri 10:00–16:00
  eq("windows intersect", intersectWindows([{ startMinute: 600, endMinute: 960 }], [{ startMinute: 480, endMinute: 780 }]), [{ startMinute: 600, endMinute: 780 }]);
  eq("the business lane: its special day", laneWindowsForDay("2026-12-11", biz, null), [{ startMinute: 480, endMinute: 780 }]);
  eq("a staff member's own hours, bounded by the business's special day (10:00–13:00, not 08:00–13:00)", laneWindowsForDay("2026-12-11", biz, own), [{ startMinute: 600, endMinute: 780 }]);
  eq("a staff member without own hours follows the special day", laneWindowsForDay("2026-12-11", biz, { rules: [], exceptions: [] }), [{ startMinute: 480, endMinute: 780 }]);
  eq("a business closure closes every lane", laneWindowsForDay("2026-12-11", { ...biz, exceptions: [{ dayKey: "2026-12-11", kind: "CLOSED", startMinute: null, endMinute: null }] }, own), []);
  eq("a business part-closure cuts a staff lane", laneWindowsForDay("2026-12-07", { rules: weekdays, exceptions: [{ dayKey: "2026-12-07", kind: "CLOSED", startMinute: 720, endMinute: 780 }] }, { rules: [{ weekday: 1, startMinute: 600, endMinute: 900 }], exceptions: [] }),
    [{ startMinute: 600, endMinute: 720 }, { startMinute: 780, endMinute: 900 }]);
  const staffEx = { rules: own.rules, exceptions: [{ dayKey: "2026-12-11", kind: "CLOSED" as const, startMinute: null, endMinute: null }] };
  eq("a staff member's own closure closes only their lane", laneWindowsForDay("2026-12-11", biz, staffEx), []);
  eq("…the business lane is untouched by it", laneWindowsForDay("2026-12-11", biz, null), [{ startMinute: 480, endMinute: 780 }]);
  eq("a staff special day stays theirs, bounded by the business's special day", laneWindowsForDay("2026-12-11", biz, { rules: [], exceptions: [{ dayKey: "2026-12-11", kind: "OPEN_HOURS", startMinute: 420, endMinute: 1200 }] }), [{ startMinute: 480, endMinute: 780 }]);
  eq("owner's calendar: on an ordinary day own hours stand outside the business's weekly hours (Saturday work)", laneWindowsForDay("2026-12-12", { rules: weekdays, exceptions: [] }, { rules: [{ weekday: 6, startMinute: 600, endMinute: 720 }], exceptions: [] }), [{ startMinute: 600, endMinute: 720 }]);
  eq("public link: staff hours only narrow the business's weekly hours (Saturday: none)", laneWindowsForDay("2026-12-12", { rules: weekdays, exceptions: [] }, { rules: [{ weekday: 6, startMinute: 600, endMinute: 720 }], exceptions: [] }, "BUSINESS_HOURS"), []);
  eq("public link: …and on a weekday the intersection", laneWindowsForDay("2026-12-07", { rules: weekdays, exceptions: [] }, { rules: [{ weekday: 1, startMinute: 480, endMinute: 720 }], exceptions: [] }, "BUSINESS_HOURS"), [{ startMinute: 540, endMinute: 720 }]);
  const slots = computeSlots({ ...base, fromDay: "2026-12-11", toDay: "2026-12-11", windowsOf: (d) => laneWindowsForDay(d, biz, own) });
  eq("slots of the staff lane on the business's short Friday: 10:00, 11:00, 12:00", slots.map((x) => iso(x.startsAt)), ["2026-12-11T08:00:00.000Z", "2026-12-11T09:00:00.000Z", "2026-12-11T10:00:00.000Z"]);
}

console.log("— G22: an appointment with a start and no end occupies time");
{
  const s0 = at("2026-12-06T08:00:00Z");
  eq("its own length", iso(effectiveEnd({ startsAt: s0, endsAt: null, durationMinutes: 45 }) as Date), "2026-12-06T08:45:00.000Z");
  eq("or the default hour", iso(effectiveEnd({ startsAt: s0, endsAt: null, durationMinutes: null }) as Date), new Date(s0.getTime() + UNTIMED_DEFAULT_MINUTES * 60_000).toISOString());
  eq("its end when it has one", iso(effectiveEnd({ startsAt: s0, endsAt: at("2026-12-06T09:30:00Z"), durationMinutes: 45 }) as Date), "2026-12-06T09:30:00.000Z");
  eq("no start: it occupies nothing", effectiveEnd({ startsAt: null, endsAt: null, durationMinutes: 30 }), null);
  const busy = [occupiedRange(s0, effectiveEnd({ startsAt: s0, endsAt: null, durationMinutes: null }) as Date, 0, 0)];
  eq("the slot at 10:00 is not offered over it", computeSlots({ ...base, busy }).map((x) => iso(x.startsAt)), ["2026-12-06T07:00:00.000Z", "2026-12-06T09:00:00.000Z"]);
}

console.log("— G25: the autumn night's repeated hour");
{
  // 25 Oct 2026: 02:00 IDT → 01:00 IST. 01:00 happens at 22:00Z (IDT) and again at 23:00Z (IST) on 24 Oct UTC.
  check("the second 01:00 is the repeated one", isRepeatedWallClock(at("2026-10-24T23:00:00Z")));
  check("the first 01:00 is not", !isRepeatedWallClock(at("2026-10-24T22:00:00Z")));
  check("an ordinary night has no repeats", !isRepeatedWallClock(at("2026-12-06T23:00:00Z")));
  const all = computeSlots({ ...base, fromDay: "2026-10-25", toDay: "2026-10-25", rules: [{ weekday: 0, startMinute: 0, endMinute: 240 }], now: at("2026-10-01T00:00:00Z") });
  const clocks = all.map((x) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(x.startsAt));
  eq("00:00–04:00 that night lists each wall-clock hour once", clocks, ["00:00", "01:00", "02:00", "03:00"]);
  eq("…the first 01:00 is the one offered", iso(all[1].startsAt), "2026-10-24T22:00:00.000Z");
}

console.log("— G20: appointments outside the hours after a change");
{
  const windowsOf = (_lane: number | null, d: string) => windowsForDay(d, weekdays, [{ dayKey: "2026-12-07", kind: "CLOSED", startMinute: null, endMinute: null }]);
  const appts = [
    { id: 1, staffMemberId: null, startsAt: at("2026-12-06T08:00:00Z"), endsAt: at("2026-12-06T09:00:00Z") }, // Sun 10:00 inside
    { id: 2, staffMemberId: null, startsAt: at("2026-12-07T08:00:00Z"), endsAt: at("2026-12-07T09:00:00Z") }, // Mon closed
    { id: 3, staffMemberId: 4, startsAt: at("2026-12-06T14:30:00Z"), endsAt: at("2026-12-06T15:30:00Z") }, // past closing
    { id: 4, staffMemberId: 4, startsAt: at("2026-12-07T10:00:00Z"), endsAt: at("2026-12-07T11:00:00Z") },
  ];
  eq("three are outside, counted per day, never changed", appointmentsOutside(appts, windowsOf, () => true),
    { count: 3, days: [{ dayKey: "2026-12-06", count: 1 }, { dayKey: "2026-12-07", count: 2 }], firstIds: [2, 3, 4] });
  eq("a lane without any hours known is never outside", appointmentsOutside(appts, windowsOf, (lane) => lane === null).count, 1);
}

console.log("— G19: the profile's opening hours, from the calendar");
{
  eq("weekdays and a short Friday, Saturday closed", openingHoursText([...weekdays, { weekday: 5, startMinute: 540, endMinute: 780 }]),
    "ראשון–חמישי 09:00–17:00 · שישי 09:00–13:00 · שבת סגור");
  eq("a night past midnight reads as one range", openingHoursText([{ weekday: 2, startMinute: 1200, endMinute: 1440 }, { weekday: 3, startMinute: 0, endMinute: 120 }]),
    "ראשון–שני סגור · שלישי 20:00–02:00 · רביעי–שבת סגור");
  eq("a break is kept", openingHoursText([{ weekday: 0, startMinute: 540, endMinute: 780 }, { weekday: 0, startMinute: 840, endMinute: 1080 }]),
    "ראשון 09:00–13:00, 14:00–18:00 · שני–שבת סגור");
  eq("no hours: nothing to write", openingHoursText([]), null);
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
