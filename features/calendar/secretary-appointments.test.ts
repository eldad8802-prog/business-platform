/**
 * Appointments milestone B — the Secretary shows appointments on its EXISTING calendar (no second calendar). Run:
 *   npx tsx features/calendar/secretary-appointments.test.ts
 *
 * An appointment becomes one event of its own kind on its Israeli day, opening in /calendar; a cancelled one is not
 * shown; appointments sort first in their day and by time; the other kinds keep their order; the read window fits
 * the API's 62 days; "תורים היום" lists today's live appointments only. Pure — no React, no fetch.
 */
import {
  appointmentLine,
  appointmentsWindow,
  calendarEvents,
  CALENDAR_KIND_LABEL,
  todayAppointments,
  type HubAppointment,
} from "@/app/(shell)/secretary/secretary-hub-model";

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

const appt = (p: Partial<HubAppointment>): HubAppointment => ({ id: 1, status: "CONFIRMED", kind: "CUSTOMER", startsAt: null, endsAt: null, title: null, ...p });

console.log("— appointments on the Secretary's calendar");
{
  const list = [
    appt({ id: 1, startsAt: "2026-11-02T07:30:00.000Z", endsAt: "2026-11-02T08:00:00.000Z", title: "תספורת" }),
    appt({ id: 2, startsAt: "2026-11-02T06:00:00.000Z", endsAt: "2026-11-02T06:30:00.000Z", kind: "INTERNAL", title: null }),
    appt({ id: 3, startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T09:30:00.000Z", status: "CANCELED", title: "בוטל" }),
    appt({ id: 4, startsAt: "2026-11-02T21:30:00.000Z", endsAt: "2026-11-02T22:30:00.000Z", title: "מאוחר" }),
  ];
  const events = calendarEvents({ obligations: [], tasks: [], summary: null, appointments: list });
  eq("one event per live appointment; a cancelled one is not shown", events.map((e) => e.key), ["a:2", "a:1", "a:4"]);
  eq("the kind is APPOINTMENT, in words", [events[0].kind, CALENDAR_KIND_LABEL.APPOINTMENT], ["APPOINTMENT", "תור"]);
  eq("the title starts with the Israeli time", events.map((e) => e.title), ["08:00 · פגישה פנימית", "09:30 · תספורת", "23:30 · מאוחר"]);
  eq("23:30 Israel time on 2.11 is still the 2nd (not the UTC day)", events[2].day, "2026-11-02");
  eq("it opens the appointment in the calendar", events[1].href, "/calendar?view=day&day=2026-11-02&appointment=1");
  eq("no money on an appointment", events.every((e) => e.amount === null), true);
  const none = calendarEvents({ obligations: [], tasks: [], summary: null });
  eq("without appointments (flag OFF) nothing changes", none.length, 0);
  const untimed = calendarEvents({ obligations: [], tasks: [], summary: null, appointments: [appt({ id: 9, startsAt: "2026-11-03T10:00:00.000Z", title: "ללא שעה" })] });
  eq("an untimed appointment shows without a time", untimed[0].title, "ללא שעה");
}

console.log("— the customer on the line");
eq("a customer appointment with a known name reads customer · what", appointmentLine(appt({ title: "תספורת", customerName: "נועה לוי" })), "נועה לוי · תספורת");
eq("without the name the title stands alone", appointmentLine(appt({ title: "תספורת" })), "תספורת");
eq("a block never names a customer", appointmentLine(appt({ kind: "BLOCK", title: null, customerName: "x" })), "חסימת זמן");
eq("a booking from the link not linked to a card yet names who asked", appointmentLine(appt({ title: "תספורת", customerName: null, booking: { contactName: "Dana Cohen" } })), "Dana Cohen · תספורת");
eq("…a linked customer's card name wins", appointmentLine(appt({ title: "תספורת", customerName: "נועה לוי", booking: { contactName: "נ." } })), "נועה לוי · תספורת");
eq("a finished appointment reads התקיים on the Secretary's calendar", calendarEvents({ obligations: [], tasks: [], summary: null, appointments: [appt({ id: 7, status: "COMPLETED", startsAt: "2026-11-02T07:00:00.000Z", endsAt: "2026-11-02T07:30:00.000Z", title: "תספורת" })] })[0].title, "09:00 · תספורת · התקיים");

console.log("— the read window and today's card");
{
  const w = appointmentsWindow(new Date("2026-11-15T10:00:00.000Z"));
  check("the window fits the API's 62 days", (w.to.getTime() - w.from.getTime()) / 86_400_000 <= 62);
  eq("it starts 30 days back at Israeli midnight", w.from.toISOString(), "2026-10-15T21:00:00.000Z");
  const dst = appointmentsWindow(new Date("2026-10-20T10:00:00.000Z"));
  check("…also across the 25-hour DST day of 25.10 (the API refuses > 62 × 24 h)", dst.to.getTime() - dst.from.getTime() <= 62 * 86_400_000);
  const today = "2026-11-02";
  const list = [
    appt({ id: 1, startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T09:30:00.000Z" }),
    appt({ id: 2, startsAt: "2026-11-02T06:00:00.000Z", endsAt: "2026-11-02T06:30:00.000Z", status: "PROPOSED" }),
    appt({ id: 3, startsAt: "2026-11-02T07:00:00.000Z", endsAt: "2026-11-02T07:30:00.000Z", status: "COMPLETED" }),
    appt({ id: 4, startsAt: "2026-11-02T08:00:00.000Z", endsAt: "2026-11-02T08:30:00.000Z", status: "CANCELED" }),
    appt({ id: 5, startsAt: "2026-11-03T06:00:00.000Z", endsAt: "2026-11-03T06:30:00.000Z" }),
  ];
  eq("today's card: live appointments of today, earliest first", todayAppointments(list, today).map((a) => a.id), [2, 1]);
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
