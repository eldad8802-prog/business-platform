/**
 * Recurring appointments (G5) and arrival / correction (G6) — the pure rules. Run:
 *   npx tsx lib/services/appointment/appointment-series-core.test.ts
 *
 * The end of a series (exactly one of N occurrences 1..104 or an until-date ≤ 730 days — never open-ended), the days
 * of weekly and bi-weekly series, the same LOCAL start time across both Israeli clock changes, ending a series before
 * one of its days; lateness computed (never stored), when an arrival may be recorded, and which final statuses may be
 * corrected to what (only what the lifecycle allows from CONFIRMED, or CONFIRMED). No database, no clock of its own.
 */
import { jerusalemClock } from "@/lib/utils/jerusalem-day";

import { arrivalRefusal, correctionTargets, lateness, LATE_GRACE_MINUTES } from "./appointment-arrival.core";
import { AppointmentServiceError } from "./appointment-errors";
import { endBefore, MAX_OCCURRENCES, parseSeriesEnd, planOccurrences, seriesDays, seriesWeekday } from "./appointment-series.core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
function refused(name: string, fn: () => unknown, field: string) {
  try {
    fn();
    check(name, false, "not refused");
  } catch (e) {
    check(name, e instanceof AppointmentServiceError && e.code === "INVALID_INPUT" && e.details.field === field, String(e instanceof AppointmentServiceError ? JSON.stringify(e.details) : e));
  }
}

console.log("1. the end of a series — exactly one of the two, inside the bounds (no open-ended series)");
refused("neither count nor date (open-ended) is refused", () => parseSeriesEnd("2026-12-01", undefined, undefined), "seriesEnd");
refused("both count and date are refused", () => parseSeriesEnd("2026-12-01", 5, "2027-01-01"), "seriesEnd");
refused("0 occurrences refused", () => parseSeriesEnd("2026-12-01", 0, undefined), "occurrenceCount");
refused("105 occurrences refused", () => parseSeriesEnd("2026-12-01", 105, undefined), "occurrenceCount");
refused("2.5 occurrences refused", () => parseSeriesEnd("2026-12-01", 2.5, undefined), "occurrenceCount");
eq("104 occurrences accepted", parseSeriesEnd("2026-12-01", 104, undefined), { occurrenceCount: 104 });
eq("1 occurrence accepted", parseSeriesEnd("2026-12-01", 1, null), { occurrenceCount: 1 });
refused("an until-date before the first day refused", () => parseSeriesEnd("2026-12-01", null, "2026-11-30"), "endsOn");
refused("an until-date 731 days ahead refused", () => parseSeriesEnd("2026-12-01", null, "2028-12-02"), "endsOn");
refused("a malformed date refused", () => parseSeriesEnd("2026-12-01", null, "2026-02-30"), "endsOn");
eq("an until-date 730 days ahead accepted", parseSeriesEnd("2026-12-01", null, "2028-11-30"), { endsOn: "2028-11-30" });

console.log("2. the days");
eq("weekly ×4 from Tue 1 Dec", seriesDays("WEEKLY", "2026-12-01", { occurrenceCount: 4 }), ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22"]);
eq("bi-weekly ×3", seriesDays("BIWEEKLY", "2026-12-01", { occurrenceCount: 3 }), ["2026-12-01", "2026-12-15", "2026-12-29"]);
eq("weekly until 29 Dec (inclusive)", seriesDays("WEEKLY", "2026-12-01", { endsOn: "2026-12-29" }).length, 5);
eq("bi-weekly until 28 Dec", seriesDays("BIWEEKLY", "2026-12-01", { endsOn: "2026-12-28" }), ["2026-12-01", "2026-12-15"]);
eq("an until-date on the first day = one occurrence", seriesDays("WEEKLY", "2026-12-01", { endsOn: "2026-12-01" }), ["2026-12-01"]);
eq("every day keeps the first day's weekday", new Set(seriesDays("WEEKLY", "2026-12-01", { occurrenceCount: 104 }).map(seriesWeekday)).size, 1);
eq("104 weekly occurrences exactly", seriesDays("WEEKLY", "2026-12-01", { occurrenceCount: MAX_OCCURRENCES }).length, 104);
refused("a weekly until-date of two years (105 days) is refused, not cut", () => seriesDays("WEEKLY", "2026-12-01", { endsOn: "2028-11-30" }), "endsOn");
eq("bi-weekly two years = 53 days", seriesDays("BIWEEKLY", "2026-12-01", { endsOn: "2028-11-30" }).length, 53);
eq("crosses a year end and a leap day", seriesDays("WEEKLY", "2028-02-22", { occurrenceCount: 2 }), ["2028-02-22", "2028-02-29"]);

console.log("3. the same local time across both clock changes (Asia/Jerusalem)");
{
  // Spring 2027: Friday 26 Mar 02:00 → 03:00. Autumn 2026: Sunday 25 Oct 02:00 → 01:00.
  const spring = planOccurrences({ frequency: "WEEKLY", startsOn: "2027-03-19", startMinute: 600, durationMinutes: 45, end: { occurrenceCount: 3 } });
  eq("spring: 10:00 local every week", spring.map((o) => jerusalemClock(o.startsAt)), [{ hours: 10, minutes: 0 }, { hours: 10, minutes: 0 }, { hours: 10, minutes: 0 }]);
  eq("spring: the UTC hour moves by one", spring.map((o) => o.startsAt.toISOString()), ["2027-03-19T08:00:00.000Z", "2027-03-26T07:00:00.000Z", "2027-04-02T07:00:00.000Z"]);
  eq("each ends 45 minutes later", spring.map((o) => (o.endsAt.getTime() - o.startsAt.getTime()) / 60000), [45, 45, 45]);
  const autumn = planOccurrences({ frequency: "WEEKLY", startsOn: "2026-10-18", startMinute: 540, durationMinutes: 30, end: { occurrenceCount: 2 } });
  eq("autumn: 09:00 local both weeks", autumn.map((o) => o.startsAt.toISOString()), ["2026-10-18T06:00:00.000Z", "2026-10-25T07:00:00.000Z"]);
  eq("indexes count from 0", autumn.map((o) => o.index), [0, 1]);
}

console.log("4. ending a series before one of its days");
eq("before the third day → ends the day before", endBefore("2026-12-01", "2026-12-15"), "2026-12-14");
eq("before the first day → nothing left (cancelled whole)", endBefore("2026-12-01", "2026-12-01"), null);

console.log("5. lateness — computed, never stored");
const start = "2026-12-01T08:00:00.000Z";
const at = (min: number) => new Date(Date.parse(start) + min * 60000);
const appt = { kind: "CUSTOMER" as const, status: "CONFIRMED" as const, startsAt: start, actualStartedAt: null as string | null };
eq("before the start: nothing", lateness(appt, at(-10)), { state: "none" });
eq(`inside the grace (${LATE_GRACE_MINUTES} min): nothing`, lateness(appt, at(LATE_GRACE_MINUTES)), { state: "none" });
eq("12 minutes after the start, not arrived: late 12", lateness(appt, at(12)), { state: "late", minutes: 12 });
eq("arrived 3 minutes late: arrived (grace)", lateness({ ...appt, actualStartedAt: at(3).toISOString() }, at(30)), { state: "arrived", minutes: 0 });
eq("arrived 17 minutes late: arrived late 17", lateness({ ...appt, actualStartedAt: at(17).toISOString() }, at(60)), { state: "arrived_late", minutes: 17 });
eq("a completed appointment is not 'late'", lateness({ ...appt, status: "COMPLETED" }, at(30)), { state: "none" });
eq("an internal meeting is never late", lateness({ ...appt, kind: "INTERNAL" }, at(30)), { state: "none" });

console.log("6. when an arrival may be recorded");
eq("confirmed, 2 h before: allowed", arrivalRefusal(appt, at(-120)), null);
eq("4 h before: too early", arrivalRefusal(appt, at(-240)), "TOO_EARLY");
eq("after the start: allowed", arrivalRefusal(appt, at(30)), null);
eq("already arrived: refused", arrivalRefusal({ ...appt, actualStartedAt: at(1).toISOString() }, at(5)), "ALREADY_ARRIVED");
eq("proposed: refused", arrivalRefusal({ ...appt, status: "PROPOSED" }, at(1)), "NOT_CONFIRMED");
eq("a block: refused", arrivalRefusal({ ...appt, kind: "BLOCK" }, at(1)), "NO_CUSTOMER");

console.log("7. status correction — only inside the lifecycle (CONFIRMED and what it allows)");
eq("live statuses are not corrected", [correctionTargets({ kind: "CUSTOMER", status: "CONFIRMED" }), correctionTargets({ kind: "CUSTOMER", status: "PROPOSED" })], [[], []]);
eq("no-show → confirmed / completed / cancelled", correctionTargets({ kind: "CUSTOMER", status: "NO_SHOW" }), ["CONFIRMED", "COMPLETED", "CANCELED"]);
eq("completed → confirmed / no-show / cancelled", correctionTargets({ kind: "CUSTOMER", status: "COMPLETED" }), ["CONFIRMED", "NO_SHOW", "CANCELED"]);
eq("cancelled → confirmed / completed / no-show", correctionTargets({ kind: "CUSTOMER", status: "CANCELED" }), ["CONFIRMED", "COMPLETED", "NO_SHOW"]);
eq("an internal meeting never becomes a no-show", correctionTargets({ kind: "INTERNAL", status: "COMPLETED" }), ["CONFIRMED", "CANCELED"]);
eq("a block: only a cancellation is undone", [correctionTargets({ kind: "BLOCK", status: "CANCELED" }), correctionTargets({ kind: "BLOCK", status: "COMPLETED" })], [["CONFIRMED"], []]);
check("never PROPOSED as a target", ["NO_SHOW", "COMPLETED", "CANCELED"].every((st) => !correctionTargets({ kind: "CUSTOMER", status: st as "NO_SHOW" }).includes("PROPOSED")));

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
