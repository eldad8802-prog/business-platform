/**
 * Verify — the three collection framings and their comparisons.
 * Run: npx tsx lib/services/home/home-collection.verify.test.ts
 *
 * The rule every assertion here defends: a period in progress is only ever
 * compared with the SAME slice of the period before it. Compare a morning with
 * a whole day and the screen reports a collapse every morning; compare a whole
 * day with a morning and it reports a miracle every evening. Both are lies the
 * owner would act on.
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import {
  changeAgainst,
  cumulate,
  resolveWindows,
} from "@/lib/services/home/home-collection.service";
import { jerusalemClock, jerusalemDayKey, jerusalemHour } from "@/lib/utils/jerusalem-day";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}

const D = (n: string) => new Prisma.Decimal(n);
const row = (iso: string, amount: string) => ({ amount: D(amount), createdAt: new Date(iso) });

/** A summer afternoon: 2026-06-15, 15:25 in Israel (UTC+3). */
const SUMMER_AFTERNOON = new Date("2026-06-15T12:25:00Z");
/** A winter morning: 2026-01-15, 09:10 in Israel (UTC+2). */
const WINTER_MORNING = new Date("2026-01-15T07:10:00Z");

function windows() {
  const t = resolveWindows("today", SUMMER_AFTERNOON);
  eq("today: the window is today", t.window, { from: "2026-06-15", to: "2026-06-15" });
  eq("today: it is compared with yesterday", t.previousWindow, { from: "2026-06-14", to: "2026-06-14" });
  eq("today: the cut is the current wall clock", t.cutoffLabel, "15:25");
  eq("today: only the hours that happened are real", t.elapsedPoints, 16); // 00..15
  eq("today: the cut lands at the same time yesterday", jerusalemClock(t.previousCut), { hours: 15, minutes: 25 });
  eq("today: and on yesterday's date", jerusalemDayKey(t.previousCut), "2026-06-14");
  ok("today: the window ends now, not at midnight", t.currentEnd.getTime() === SUMMER_AFTERNOON.getTime());

  const y = resolveWindows("yesterday", SUMMER_AFTERNOON);
  eq("yesterday: the window is yesterday", y.window, { from: "2026-06-14", to: "2026-06-14" });
  eq("yesterday: it is compared with the day before", y.previousWindow, { from: "2026-06-13", to: "2026-06-13" });
  eq("yesterday: a finished day has no cut label", y.cutoffLabel, null);
  eq("yesterday: all 24 hours are real", y.elapsedPoints, 24);
  eq("yesterday: the comparison covers the whole day before", jerusalemDayKey(new Date(y.previousCut.getTime() - 1)), "2026-06-13");

  const w = resolveWindows("week", SUMMER_AFTERNOON);
  eq("week: the last seven days, today included", w.window, { from: "2026-06-09", to: "2026-06-15" });
  eq("week: against the seven before them", w.previousWindow, { from: "2026-06-02", to: "2026-06-08" });
  eq("week: seven points", w.length, 7);
  eq("week: the cut is the same wall clock on the last day of that window", jerusalemDayKey(w.previousCut), "2026-06-08");
  eq("week: at the same time of day", jerusalemClock(w.previousCut), { hours: 15, minutes: 25 });

  // Winter: the same logic, an hour of offset different.
  const winter = resolveWindows("today", WINTER_MORNING);
  eq("winter: the Israeli day is right", winter.window, { from: "2026-01-15", to: "2026-01-15" });
  eq("winter: the cut is the current wall clock", winter.cutoffLabel, "09:10");
  eq("winter: ten hours have happened", winter.elapsedPoints, 10);
  eq("winter: the comparison cut is the same time yesterday", jerusalemClock(winter.previousCut), { hours: 9, minutes: 10 });

  // The windows must not overlap, in either direction.
  ok("today: the previous window ends where the current one starts", resolveWindows("today", SUMMER_AFTERNOON).previousEnd.getTime() === resolveWindows("today", SUMMER_AFTERNOON).currentStart.getTime());
  ok("week: the previous window ends where the current one starts", w.previousEnd.getTime() === w.currentStart.getTime());
}

function series() {
  // 06:00 and 14:00 in Israel on a summer day.
  const rows = [row("2026-06-15T03:00:00Z", "200.00"), row("2026-06-15T11:00:00Z", "420.00")];
  const c = cumulate(rows, (r) => jerusalemHour(r.createdAt), 24);
  eq("nothing before the first payment", c.points[5], "0.00");
  eq("the first payment lands at 06", c.points[6], "200.00");
  eq("and stays there until the next one", c.points[13], "200.00");
  eq("the second payment lands at 14", c.points[14], "620.00");
  eq("a cumulative series never goes down", c.points[23], "620.00");
  eq("the total is the money", c.total.toFixed(2), "620.00");
  eq("the count is the payments", c.count, 2);

  const empty = cumulate([], (r) => jerusalemHour(r.createdAt), 24);
  eq("a day with nothing is 24 zeros", empty.points.filter((p) => p !== "0.00").length, 0);
  eq("and totals zero", empty.total.toFixed(2), "0.00");

  // A week bucketed by day.
  const weekRows = [row("2026-06-09T09:00:00Z", "100.00"), row("2026-06-15T09:00:00Z", "50.00")];
  const byDay = (r: { createdAt: Date }) => {
    const ord = (k: string) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((ord(jerusalemDayKey(r.createdAt)) - ord("2026-06-09")) / 86_400_000);
  };
  const week = cumulate(weekRows, byDay, 7);
  eq("the first day of the week carries its money", week.points[0], "100.00");
  eq("the last day adds to it", week.points[6], "150.00");
}

function comparison() {
  eq("a doubling reads as +100%", changeAgainst(D("2000"), D("1000")), 100);
  eq("a halving reads as −50%", changeAgainst(D("500"), D("1000")), -50);
  eq("620 against 484 rounds to +28%", changeAgainst(D("620"), D("484")), 28);
  eq("unchanged reads as 0%", changeAgainst(D("620"), D("620")), 0);
  eq("nothing to compare against gives NO percentage", changeAgainst(D("620"), D("0")), null);
  eq("two empty periods still give none", changeAgainst(D("0"), D("0")), null);
  ok("a missing comparison is null, never a number", changeAgainst(D("620"), D("0")) === null);
}

function main() {
  windows();
  series();
  comparison();
  console.log(`home-collection.verify.test.ts: ok (${checks} checks)`);
}

main();
