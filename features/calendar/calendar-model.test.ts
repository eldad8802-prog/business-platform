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
  dayAvailability,
  availabilityWarning,
  closureBands,
  durationLabel,
  errorText,
  exceptionText,
  gridHours,
  headline,
  instantAt,
  layoutDay,
  LIMITS,
  NO_AVAILABILITY,
  noSlotsReason,
  openWindows,
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
  assignmentWrites,
  bookingDeadEnd,
  COLOR_NAME,
  currentPick,
  dayLanes,
  hoursSummary,
  keepStaffFor,
  nextRange,
  nextStaffColor,
  requestOutcome,
  samePick,
  splitMinutes,
  STAFF_PALETTE,
  staffForService,
  timeOptionLabel,
  timeOptions,
  type StaffWire,
  type AppointmentWire,
  type Availability,
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
const BEFORE = new Date("2026-11-02T06:00:00Z"); // an hour before the appointments below start
const AFTER = new Date("2026-11-02T07:30:00Z"); // half an hour into them
const timed = { startsAt: "2026-11-02T07:00:00Z", endsAt: "2026-11-02T08:00:00Z" };
eq("a proposed appointment: confirm, move, edit, cancel", actionsFor(appt({ status: "PROPOSED", ...timed }), BEFORE), ["confirm", "move", "edit", "cancel"]);
eq("a confirmed one that has started: completed, no-show, move, edit, cancel", actionsFor(appt(timed), AFTER), ["complete", "no_show", "move", "edit", "cancel"]);
eq("a confirmed one still in the future: no completed, no no-show", actionsFor(appt(timed), BEFORE), ["move", "edit", "cancel"]);
eq("…exactly at its start time it may be completed", actionsFor(appt(timed), new Date(timed.startsAt)).includes("complete"), true);
eq("an internal item that has started: completed, but never a no-show", actionsFor(appt({ kind: "INTERNAL", ...timed }), AFTER), ["complete", "move", "edit", "cancel"]);
eq("a block: move, edit, cancel — never completed, even after its start", actionsFor(appt({ kind: "BLOCK", ...timed }), AFTER), ["move", "edit", "cancel"]);
eq("an untimed one cannot be dragged", actionsFor(appt({}), BEFORE).includes("move"), false);
eq("a cancelled one: nothing", actionsFor(appt({ status: "CANCELED" }), AFTER), []);
eq("a completed one: nothing", actionsFor(appt({ status: "COMPLETED" }), AFTER), []);
eq("a no-show: nothing", actionsFor(appt({ status: "NO_SHOW" }), AFTER), []);
eq("the refusal reads as a sentence", errorText("NOT_STARTED").includes("אחרי שעת התחלת התור"), true);

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

console.log("— what is open (the free-slot rule, as shown)");
{
  // Business Sun–Thu 09:00–17:00, Fri 09:00–13:00; 4.11.2026 (Wed) closed 12:00–14:00; 5.11 (Thu) closed all day.
  const week = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })).concat([{ weekday: 5, startMinute: 540, endMinute: 780 }]);
  const av: Availability = {
    business: {
      rules: week,
      exceptions: [
        { dayKey: "2026-11-04", kind: "CLOSED", startMinute: 720, endMinute: 840, label: null },
        { dayKey: "2026-11-05", kind: "CLOSED", startMinute: null, endMinute: null, label: "חג" },
      ],
    },
    staff: new Map([
      [1, { rules: [], exceptions: [{ dayKey: "2026-11-03", kind: "CLOSED", startMinute: null, endMinute: null, label: null }] }], // inherits the business's hours
      [2, { rules: [{ weekday: 2, startMinute: 600, endMinute: 900 }], exceptions: [] }], // own hours: Tue 10:00–15:00
    ]),
  };
  const names: Names = {
    customers: new Map(), services: new Map(),
    staff: new Map([
      [1, { id: 1, displayName: "שירה", color: null, active: true, sortOrder: 0, version: 1, services: [] }],
      [2, { id: 2, displayName: "אבי", color: null, active: true, sortOrder: 1, version: 1, services: [] }],
    ]),
  };
  eq("an ordinary day: the weekly hours", openWindows(av, null, "2026-11-03"), [{ startMinute: 540, endMinute: 1020 }]);
  eq("4.11: the 12:00–14:00 closure is cut out", openWindows(av, null, "2026-11-04"), [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1020 }]);
  eq("5.11: closed all day", openWindows(av, null, "2026-11-05"), []);
  eq("Saturday: closed by the weekly hours", openWindows(av, null, "2026-11-07"), []);
  eq("a staff member without own hours works by the business's", openWindows(av, 1, "2026-11-02"), [{ startMinute: 540, endMinute: 1020 }]);
  eq("…and the business's closure applies to them too", openWindows(av, 1, "2026-11-04"), [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1020 }]);
  eq("…and their own day off", openWindows(av, 1, "2026-11-03"), []);
  eq("a staff member's own hours replace the business's", openWindows(av, 2, "2026-11-03"), [{ startMinute: 600, endMinute: 900 }]);
  eq("…and on a day they have no hours, they are off", openWindows(av, 2, "2026-11-02"), []);
  eq("the business closure still cuts their own hours", openWindows(av, 2, "2026-11-05"), []);
  eq("nothing set at all: nothing is shaded", openWindows(NO_AVAILABILITY, null, "2026-11-03"), null);
  eq("no weekly hours but a closure: only the closure", openWindows({ business: { rules: [], exceptions: av.business.exceptions }, staff: new Map() }, null, "2026-11-04"), [{ startMinute: 0, endMinute: 720 }, { startMinute: 840, endMinute: 1440 }]);
  eq("month/phone: 5.11 is closed, with its reason", dayAvailability(av, "2026-11-05", names), { closed: true, notes: ["סגור כל היום · חג"] });
  eq("month/phone: 4.11 is open, naming the part closed", dayAvailability(av, "2026-11-04", names), { closed: false, notes: ["סגור ⁦12:00–14:00⁩"] });
  eq("month/phone: a staff member's day off is named", dayAvailability(av, "2026-11-03", names).notes, ["שירה: סגור כל היום"]);
  // Before booking: a time not offered says why (the server still accepts it, with OUTSIDE_AVAILABILITY).
  eq("12:30 on 4.11 falls in the closure, said before booking", availabilityWarning(av, null, "2026-11-04", 750, 30, names), "השעה נופלת בזמן סגור: סגור ⁦12:00–14:00⁩.");
  eq("…a booking that only touches the closure's edge is fine", availabilityWarning(av, null, "2026-11-04", 690, 30, names), null);
  eq("…and one that runs into it is not", availabilityWarning(av, null, "2026-11-04", 700, 30, names)?.startsWith("השעה נופלת בזמן סגור"), true);
  eq("a closed day names its reason", availabilityWarning(av, null, "2026-11-05", 600, 30, names), "השעה נופלת בזמן סגור: סגור · חג (כל היום).");
  eq("a time before opening says the hours", availabilityWarning(av, null, "2026-11-03", 480, 30, names), "השעה מחוץ לשעות הפעילות ביום הזה (⁦09:00–17:00⁩).");
  eq("Saturday: the business is not open", availabilityWarning(av, null, "2026-11-07", 600, 30, names), "העסק לא פעיל ביום הזה לפי שעות הפעילות.");
  eq("a staff member's own day off is named with their name", availabilityWarning(av, 1, "2026-11-03", 600, 30, names), "השעה נופלת בזמן סגור: שירה: סגור (כל היום).");
  eq("inside the hours: no warning", availabilityWarning(av, null, "2026-11-03", 600, 30, names), null);
  eq("nothing known: no warning", availabilityWarning(NO_AVAILABILITY, null, "2026-11-03", 600, 30, names), null);
  eq("no free time on a closed day: the reason", noSlotsReason(av, null, "2026-11-05", names), "היום סגור: סגור · חג.");
  eq("…on an open day: none", noSlotsReason(av, null, "2026-11-04", names), null);
  eq("the grid names a closure", closureBands(av, null, "2026-11-04", names), [{ start: 720, end: 840, label: "סגור" }]);
  eq("…a staff lane names its own closure and the business's", closureBands(av, 1, "2026-11-03", names), [{ start: 0, end: 1440, label: "שירה: סגור" }]);
  eq("special hours read as such", exceptionText({ dayKey: "2026-11-06", kind: "OPEN_HOURS", startMinute: 600, endMinute: 780 }), "שעות מיוחדות ⁦10:00–13:00⁩");
}

console.log("— redesign: lanes, hours in words, ranges, units, colours, who performs what");
{
  const member = (id: number, partial: Partial<StaffWire> = {}): StaffWire => ({ id, displayName: `ע${id}`, color: null, active: true, sortOrder: id, version: 1, services: [], ...partial });
  const staff = [member(1, { displayName: "שירה" }), member(2, { displayName: "דנה", active: false }), member(3, { displayName: "יוסי", active: false })];
  const day = [appt({ staffMemberId: 2, startsAt: at("2026-11-03", "10:00"), endsAt: at("2026-11-03", "10:30") })];
  eq("day lanes: the business, the active staff, and an inactive one who has an appointment that day",
    dayLanes(staff, day).map((l) => l.label), ["ללא עובד", "שירה", "דנה (לא פעיל)"]);
  check("…an inactive staff member with no appointment that day has no lane", !dayLanes(staff, day).some((l) => l.staffMemberId === 3));
  eq("…a staff id the list does not know still gets a lane", dayLanes([], [appt({ staffMemberId: 9 })]).map((l) => l.staffMemberId), [null, 9]);

  eq("hours in one line, equal days joined", hoursSummary([0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })).concat([{ weekday: 5, startMinute: 540, endMinute: 780 }])),
    "א׳–ה׳ ⁦09:00–17:00⁩ · ו׳ ⁦09:00–13:00⁩");
  eq("…a break is two ranges", hoursSummary([{ weekday: 0, startMinute: 540, endMinute: 780 }, { weekday: 0, startMinute: 840, endMinute: 1080 }]), "א׳ ⁦09:00–13:00⁩, ⁦14:00–18:00⁩");
  eq("…end of day reads 24:00", hoursSummary([{ weekday: 6, startMinute: 1200, endMinute: 1440 }]), "ש׳ ⁦20:00–24:00⁩");
  eq("…no hours", hoursSummary([]), null);

  eq("+ range after an evening range never passes midnight", nextRange([{ startMinute: 1080, endMinute: 1380 }]), { startMinute: 1380, endMinute: 1440 });
  eq("+ range when the day already ends at 24:00: no room", nextRange([{ startMinute: 540, endMinute: 1440 }]), null);
  eq("+ range after 09:00–13:00 starts at 13:00", nextRange([{ startMinute: 540, endMinute: 780 }]), { startMinute: 780, endMinute: 900 });
  eq("+ range on an empty day", nextRange([]), { startMinute: 540, endMinute: 1020 });
  check("end-time options reach 24:00 and read it", timeOptions("end").at(-1) === 1440 && timeOptionLabel(1440) === "24:00");
  check("…an off-grid saved time stays selectable", timeOptions("start", 545).includes(545));

  eq("2 days reads as days", splitMinutes(2880), { value: 2, unit: "days" });
  eq("3 hours reads as hours", splitMinutes(180), { value: 3, unit: "hours" });
  eq("90 minutes stays minutes", splitMinutes(90), { value: 90, unit: "minutes" });
  eq("0 stays minutes", splitMinutes(0), { value: 0, unit: "minutes" });

  eq("a new staff member gets the first unused colour", nextStaffColor([{ color: STAFF_PALETTE[0] }, { color: null }]), STAFF_PALETTE[1]);
  check("every palette colour has a Hebrew name", STAFF_PALETTE.every((c) => /[֐-׿]/.test(COLOR_NAME[c] ?? "")));

  const svc = [member(1, { services: [{ businessServiceId: 10, durationOverrideMinutes: 50 }, { businessServiceId: 11, durationOverrideMinutes: null }] }), member(4, { services: [] })];
  eq("staff for a service: those assigned", staffForService(svc, 10).map((m) => m.id), [1]);
  eq("…nobody assigned: every active", staffForService(svc, 12).map((m) => m.id), [1, 4]);
  eq("a chosen staff member who does not perform the new service is cleared", keepStaffFor(svc, 10, 4), null);
  eq("…a fitting choice is kept", keepStaffFor(svc, 10, 1), 1);

  eq("from the service page: assigning adds this service only, every other entry and length kept",
    assignmentWrites(svc, { kind: "service", serviceId: 12 }, new Map([[1, null]])).map((w) => [w.member.id, w.services]),
    [[1, [{ businessServiceId: 10, durationOverrideMinutes: 50 }, { businessServiceId: 11, durationOverrideMinutes: null }, { businessServiceId: 12, durationOverrideMinutes: null }]]]);
  eq("…unassigning removes only this service", assignmentWrites(svc, { kind: "service", serviceId: 10 }, new Map()).map((w) => [w.member.id, w.services]),
    [[1, [{ businessServiceId: 11, durationOverrideMinutes: null }]]]);
  eq("…a changed personal length is one write", assignmentWrites(svc, { kind: "service", serviceId: 10 }, new Map([[1, 40]])).map((w) => w.services[1]),
    [{ businessServiceId: 10, durationOverrideMinutes: 40 }]);
  eq("…no change, no write", assignmentWrites(svc, { kind: "service", serviceId: 10 }, currentPick(svc, { kind: "service", serviceId: 10 })).length, 0);
  eq("from the staff page: the member's whole list", assignmentWrites(svc, { kind: "staff", staffId: 4 }, new Map([[10, 35]])).map((w) => [w.member.id, w.services]),
    [[4, [{ businessServiceId: 10, durationOverrideMinutes: 35 }]]]);
  check("both pages read the same picture", samePick(currentPick(svc, { kind: "service", serviceId: 10 }), new Map([[1, 50]])) && samePick(currentPick(svc, { kind: "staff", staffId: 1 }), new Map([[10, 50], [11, null]])));

  eq("a customer's cancellation of an approved booking reads as cancelled", requestOutcome({ status: "APPROVED", appointment: { status: "CANCELED" } }), { label: "התור בוטל", tone: "off" });
  eq("…an approved one stays approved", requestOutcome({ status: "APPROVED", appointment: { status: "CONFIRMED" } }).label, "אושרה");
  eq("…a lapsed one", requestOutcome({ status: "EXPIRED", appointment: { status: "CANCELED" } }).label, "פגה");
  check("required staff choice + hidden names is named before it closes the link", bookingDeadEnd({ staffChoiceMode: "REQUIRED", showStaffNames: false }, true) !== null);
  eq("…shown names, or no staff at all, is fine", [bookingDeadEnd({ staffChoiceMode: "REQUIRED", showStaffNames: true }, true), bookingDeadEnd({ staffChoiceMode: "REQUIRED", showStaffNames: false }, false), bookingDeadEnd({ staffChoiceMode: "OPTIONAL", showStaffNames: false }, true)], [null, null, null]);
  eq("the completed status reads התקיים", STATUS_LABEL.COMPLETED, "התקיים");
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
