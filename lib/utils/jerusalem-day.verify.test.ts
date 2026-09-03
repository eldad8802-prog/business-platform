/**
 * Verify — Israeli calendar-day semantics.
 * Run: npx tsx lib/utils/jerusalem-day.verify.test.ts
 *
 * Israel moves its clocks on the Friday before the last Sunday of March, and
 * back on the last Sunday of October. Every assertion below that mentions DST
 * exists because millisecond arithmetic gets that period wrong, and the billing
 * rules built on this module must not.
 */
import assert from "node:assert/strict";

import {
  addCalendarDays,
  dayKeyIsBefore,
  dayKeyToStableInstant,
  jerusalemHour,
  daysBetweenDayKeys,
  jerusalemDayKey,
} from "@/lib/utils/jerusalem-day";

let checks = 0;
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, `${label} (got ${String(actual)})`);
  checks += 1;
}

const MS_PER_DAY = 86_400_000;

function main() {
  /* ------------------------------------------------------------ day keys --- */

  eq(
    "an instant maps to its Israeli calendar day",
    jerusalemDayKey(new Date("2026-06-15T09:00:00Z")),
    "2026-06-15"
  );

  // 21:30 UTC is 00:30 the NEXT day in Israel (UTC+3 in summer). A server
  // reading its own clock would have called this 15 June and been a day out.
  eq(
    "late-evening UTC is already tomorrow in Israel",
    jerusalemDayKey(new Date("2026-06-15T21:30:00Z")),
    "2026-06-16"
  );

  // The same UTC hour in winter is 23:30 Israel (UTC+2) — still the same day.
  eq(
    "the same UTC hour in winter is still today in Israel",
    jerusalemDayKey(new Date("2026-01-15T21:30:00Z")),
    "2026-01-15"
  );

  /* --------------------------------------------------- the DST regression -- */

  // The bug this module was written for: 20 March 09:00 + 30 days.
  const issued = new Date("2026-03-20T07:00:00Z"); // 09:00 Jerusalem, UTC+2
  const naive = new Date(issued.getTime() + 30 * MS_PER_DAY);
  const calendar = addCalendarDays(jerusalemDayKey(issued), 30);

  eq("issuance lands on 20 March in Israel", jerusalemDayKey(issued), "2026-03-20");
  eq("calendar arithmetic gives 19 April", calendar, "2026-04-19");
  eq(
    "millisecond arithmetic also lands on 19 April — but at the wrong hour",
    jerusalemDayKey(naive),
    "2026-04-19"
  );

  // The day survives; the wall-clock time does not. That hour is the whole bug:
  // it moved the moment an invoice turned into a debt.
  const hourOf = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d);
  eq("issued at 09 Israel time", hourOf(issued), "09");
  eq("naive +30d drifted to 10 Israel time", hourOf(naive), "10");

  /* ------------------------------------ spans that cross a clock change ---- */

  eq(
    "30 calendar days across the spring change",
    daysBetweenDayKeys("2026-03-20", addCalendarDays("2026-03-20", 30)),
    30
  );
  eq(
    "30 calendar days across the autumn change",
    daysBetweenDayKeys("2026-10-15", addCalendarDays("2026-10-15", 30)),
    30
  );

  /* -------------------------------------------------- calendar arithmetic -- */

  eq("month rollover", addCalendarDays("2026-01-31", 1), "2026-02-01");
  eq("year rollover", addCalendarDays("2026-12-31", 1), "2027-01-01");
  eq("February in a common year", addCalendarDays("2026-02-28", 1), "2026-03-01");
  eq("February in a leap year", addCalendarDays("2028-02-28", 1), "2028-02-29");
  eq("leap day rolls to March", addCalendarDays("2028-02-29", 1), "2028-03-01");
  eq("zero days is identity", addCalendarDays("2026-05-05", 0), "2026-05-05");
  eq("negative days go backwards", addCalendarDays("2026-03-01", -1), "2026-02-28");
  eq("a full common year", daysBetweenDayKeys("2026-01-01", "2027-01-01"), 365);
  eq("a full leap year", daysBetweenDayKeys("2028-01-01", "2029-01-01"), 366);

  /* ------------------------------------------------------------ distances -- */

  eq("same day is zero", daysBetweenDayKeys("2026-06-15", "2026-06-15"), 0);
  eq("forward is positive", daysBetweenDayKeys("2026-06-15", "2026-06-18"), 3);
  eq("backward is negative", daysBetweenDayKeys("2026-06-18", "2026-06-15"), -3);

  /* ---------------------------------------------------------- comparisons -- */

  ok("earlier is before later", dayKeyIsBefore("2026-06-15", "2026-06-16"));
  ok("a day is not before itself", !dayKeyIsBefore("2026-06-15", "2026-06-15"));
  ok("later is not before earlier", !dayKeyIsBefore("2026-06-16", "2026-06-15"));
  ok("comparison spans months", dayKeyIsBefore("2026-01-31", "2026-02-01"));
  ok("comparison spans years", dayKeyIsBefore("2026-12-31", "2027-01-01"));

  /* ------------------------------------------------------- round-tripping -- */

  // The property the billing read model depends on: a day key encoded as a Date
  // must read back as the same day in Israel, in every season and on the two
  // days each year when the offset itself changes.
  for (const key of [
    "2026-01-01",
    "2026-03-27", // day of the spring clock change
    "2026-03-28",
    "2026-06-15",
    "2026-10-25", // day of the autumn clock change
    "2026-10-26",
    "2026-12-31",
    "2028-02-29", // leap day
  ]) {
    eq(`round-trips ${key}`, jerusalemDayKey(dayKeyToStableInstant(key)), key);
  }

  // Exhaustive sweep of a full year, so no single day can regress unnoticed.
  let day = "2026-01-01";
  let swept = 0;
  while (dayKeyIsBefore(day, "2027-01-01")) {
    assert.equal(
      jerusalemDayKey(dayKeyToStableInstant(day)),
      day,
      `round-trip failed on ${day}`
    );
    day = addCalendarDays(day, 1);
    swept += 1;
  }
  eq("swept every day of 2026", swept, 365);

  /* --------------------------------------------------------- hour of day -- */

  // Israel is UTC+2 in winter and UTC+3 in summer, so the same UTC hour is a
  // different wall-clock hour depending on the season. A quiet-hours rule built
  // on the server clock would be wrong for half the year.
  eq("summer: 09:00Z is 12:00 in Israel", jerusalemHour(new Date("2026-06-15T09:00:00Z")), 12);
  eq("winter: 09:00Z is 11:00 in Israel", jerusalemHour(new Date("2026-01-15T09:00:00Z")), 11);

  // Midnight must be 0, never 24. Some locales render h24 by default, which
  // would silently break every `hour < 7` comparison.
  eq("summer midnight is 0", jerusalemHour(new Date("2026-06-14T21:00:00Z")), 0);
  eq("winter midnight is 0", jerusalemHour(new Date("2026-01-14T22:00:00Z")), 0);
  eq("23:00 Israel reads as 23", jerusalemHour(new Date("2026-06-15T20:00:00Z")), 23);

  // Across the spring change the offset shifts; the wall-clock hour must follow
  // the offset rather than the UTC clock.
  eq("before the spring change: 07:00Z is 09", jerusalemHour(new Date("2026-03-20T07:00:00Z")), 9);
  eq("after the spring change: 07:00Z is 10", jerusalemHour(new Date("2026-04-19T07:00:00Z")), 10);

  {
    let allInRange = true;
    for (let h = 0; h < 24; h += 1) {
      const v = jerusalemHour(new Date(Date.UTC(2026, 5, 15, h, 30)));
      if (!Number.isInteger(v) || v < 0 || v > 23) allInRange = false;
    }
    ok("every hour of a day maps into 0..23", allInRange);
  }

  console.log(`jerusalem-day.verify.test.ts: ok (${checks} checks)`);
}

main();
