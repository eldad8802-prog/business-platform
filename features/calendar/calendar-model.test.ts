/**
 * Appointments milestone B — the calendar's pure rules. Run:
 *   npx tsx features/calendar/calendar-model.test.ts
 *
 * Views and their ranges (≤ 62 days, Sunday weeks), Israeli wall clock on both DST change days, the day layout
 * (overlaps side by side, clipping at midnight), the owner's actions per status and kind, the API's field limits,
 * and the words the screens show. No database, no clock of its own.
 */
import {
  actionsFor,
  byDay,
  clock,
  clockOf,
  durationLabel,
  errorText,
  gridHours,
  headline,
  instantAt,
  layoutDay,
  LIMITS,
  minuteInDay,
  parseClock,
  shiftAnchor,
  snap,
  STATUS_LABEL,
  textProblem,
  timeLabel,
  viewDays,
  viewRange,
  viewTitle,
  weekStart,
  windowsProblem,
  type AppointmentWire,
  type Names,
} from "./calendar-model";

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

let nextId = 1;
function appt(partial: Partial<AppointmentWire>): AppointmentWire {
  return {
    id: nextId++, status: "CONFIRMED", kind: "CUSTOMER", startsAt: null, endsAt: null, durationMinutes: null,
    staffMemberId: null, businessServiceId: null, customerId: null, leadId: null, title: null, notes: null,
    locationKind: null, locationDetail: null, cancelReason: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, version: 1,
    ...partial,
  };
}
const at = (day: string, hhmm: string) => instantAt(day, parseClock(hhmm)!).toISOString();

console.log("— views and ranges");
eq("a week starts on Sunday", weekStart("2026-11-04"), "2026-11-01");
eq("the week view is Sunday … Saturday", viewDays("week", "2026-11-04"), ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
eq("the month view holds every day of the month", viewDays("month", "2026-02-10").length, 28);
eq("a day view is its day", viewDays("day", "2026-11-04"), ["2026-11-04"]);
{
  const r = viewRange("month", "2026-12-15");
  check("a month range fits the API's 62 days", (r.to.getTime() - r.from.getTime()) / 86_400_000 <= LIMITS.rangeDays);
  eq("…and starts at Israeli midnight of the 1st (22:00Z in winter)", r.from.toISOString(), "2026-11-30T22:00:00.000Z");
  eq("…and ends at midnight of the 1st of the next month", r.to.toISOString(), "2026-12-31T22:00:00.000Z");
}
eq("next day", shiftAnchor("day", "2026-12-31", 1), "2027-01-01");
eq("previous week", shiftAnchor("week", "2026-11-04", -1), "2026-10-28");
eq("next month lands on the 1st", shiftAnchor("month", "2026-01-31", 1), "2026-02-01");
eq("previous month across a year", shiftAnchor("month", "2026-01-15", -1), "2025-12-01");
check("a week title names both ends", viewTitle("week", "2026-11-04").includes("–"));

console.log("— Israeli wall clock on the DST change days");
eq("spring change (27.3.2026): 09:00 is 06:00Z", at("2026-03-27", "09:00"), "2026-03-27T06:00:00.000Z");
eq("autumn change (25.10.2026): 09:00 is 07:00Z", at("2026-10-25", "09:00"), "2026-10-25T07:00:00.000Z");
eq("the minute of day reads back the wall clock", minuteInDay(new Date(at("2026-10-25", "14:30")), "2026-10-25"), 14 * 60 + 30);
eq("clockOf reads Israel time", clockOf(new Date("2026-07-01T06:15:00.000Z")), "09:15");
eq("clock formats minutes", clock(9 * 60 + 5), "09:05");
eq("parseClock refuses 24:00", parseClock("24:00"), null);
eq("parseClock reads 7:30", parseClock("7:30"), 450);

console.log("— the day layout");
{
  const day = "2026-11-02";
  const a = appt({ startsAt: at(day, "09:00"), endsAt: at(day, "10:00") });
  const b = appt({ startsAt: at(day, "09:30"), endsAt: at(day, "10:30") });
  const c = appt({ startsAt: at(day, "11:00"), endsAt: at(day, "11:30") });
  const untimed = appt({ startsAt: at(day, "12:00") });
  const placed = layoutDay([a, b, c, untimed], day);
  eq("untimed appointments are not drawn on the grid", placed.length, 3);
  const pa = placed.find((p) => p.appt.id === a.id)!;
  const pb = placed.find((p) => p.appt.id === b.id)!;
  const pc = placed.find((p) => p.appt.id === c.id)!;
  eq("two overlapping appointments share the row in two columns", [pa.col, pb.col, pa.cols, pb.cols], [0, 1, 2, 2]);
  eq("the next, separate appointment takes the full width", [pc.col, pc.cols], [0, 1]);
  eq("minutes from midnight", [pa.start, pa.end], [540, 600]);
  const late = appt({ startsAt: at(day, "23:30"), endsAt: at("2026-11-03", "00:30") });
  eq("an appointment past midnight is clipped to the day", layoutDay([late], day).map((p) => p.end), [1440]);
  eq("the grid widens to hold an early appointment", gridHours(layoutDay([appt({ startsAt: at(day, "06:15"), endsAt: at(day, "07:00") })], day)).first, 6);
  eq("the default grid is 07–21", gridHours([]), { first: 7, last: 21 });
  eq("snap to 15 minutes", [snap(52), snap(53), snap(1439)], [45, 60, 1425]);
  const grouped = byDay([c, a, untimed, appt({})]);
  eq("by day: ordered by start, appointments without a start left out", grouped.get(day)!.map((x) => x.id), [a.id, c.id, untimed.id]);
  eq("on the autumn change day 14:30 sits at 14:30 on the grid", minuteInDay(new Date(at("2026-10-25", "14:30")), "2026-10-25"), 870);
  eq("on the spring change day 14:30 sits at 14:30 on the grid", minuteInDay(new Date(at("2026-03-27", "14:30")), "2026-03-27"), 870);
}

console.log("— what the owner may do");
eq("a proposed appointment: confirm, move, edit, cancel", actionsFor(appt({ status: "PROPOSED", startsAt: "2026-11-02T07:00:00Z", endsAt: "2026-11-02T08:00:00Z" })), ["confirm", "move", "edit", "cancel"]);
eq("a confirmed one: completed, no-show, move, edit, cancel", actionsFor(appt({ startsAt: "2026-11-02T07:00:00Z", endsAt: "2026-11-02T08:00:00Z" })), ["complete", "no_show", "move", "edit", "cancel"]);
eq("a block: move, edit, cancel — never completed", actionsFor(appt({ kind: "BLOCK", startsAt: "2026-11-02T07:00:00Z", endsAt: "2026-11-02T08:00:00Z" })), ["move", "edit", "cancel"]);
eq("an untimed one cannot be dragged", actionsFor(appt({})).includes("move"), false);
eq("a cancelled one: nothing", actionsFor(appt({ status: "CANCELED" })), []);
eq("a completed one: nothing", actionsFor(appt({ status: "COMPLETED" })), []);

console.log("— limits and words");
eq("the API's limits", [LIMITS.title, LIMITS.notes, LIMITS.locationDetail, LIMITS.cancelReason, LIMITS.staffName], [200, 4000, 300, 500, 80]);
check("a long title is refused in Hebrew", (textProblem("כותרת", "x".repeat(201), LIMITS.title) ?? "").includes("עד 200"));
eq("a title at the limit passes", textProblem("כותרת", "x".repeat(200), LIMITS.title), null);
check("every status has Hebrew words", Object.values(STATUS_LABEL).every((v) => /[֐-׿]/.test(v)));
check("a slot conflict speaks Hebrew", /[֐-׿]/.test(errorText("SLOT_CONFLICT")));
check("an unknown error is never shown raw", !errorText("SOMETHING_ELSE").includes("SOMETHING"));
eq("durations", [durationLabel(45), durationLabel(60), durationLabel(90), durationLabel(120)], ["45 דק׳", "שעה", "שעה ו־30 דק׳", "שעתיים"]);
eq("time label of an untimed appointment", timeLabel(appt({})), "ללא שעה");
eq("windows: an overlap is refused", windowsProblem([{ startMinute: 540, endMinute: 720 }, { startMinute: 700, endMinute: 800 }]) !== null, true);
eq("windows: end before start is refused", windowsProblem([{ startMinute: 600, endMinute: 540 }]) !== null, true);
eq("windows: two separate windows pass", windowsProblem([{ startMinute: 540, endMinute: 720 }, { startMinute: 780, endMinute: 1020 }]), null);
{
  const names: Names = { customers: new Map([[7, "דנה"]]), services: new Map([[3, "תספורת"]]), staff: new Map() };
  eq("a customer appointment reads customer · service", headline(appt({ customerId: 7, businessServiceId: 3 }), names), "דנה · תספורת");
  eq("a meeting reads its title", headline(appt({ kind: "INTERNAL", title: "ישיבת צוות" }), names), "ישיבת צוות");
  eq("a block without a title reads its kind", headline(appt({ kind: "BLOCK" }), names), "חסימת זמן");
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
