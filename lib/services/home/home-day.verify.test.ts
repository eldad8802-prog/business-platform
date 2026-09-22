/**
 * Verify — the Home day read model.
 * Run: npx tsx lib/services/home/home-day.verify.test.ts
 *
 * Every assertion here is about a way the screen could lie: a payment landing
 * in the wrong hour, a day the business never had, a comparison invented out of
 * a month with no money in it, or a zero standing in for "we do not know".
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import {
  bucketByJerusalemHour,
  monthChangePct,
  normalizeDayKey,
} from "@/lib/services/home/home-day.service";

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
const at = (iso: string, amount: string) => ({ amount: D(amount), createdAt: new Date(iso) });

function buckets() {
  // Israel is UTC+3 in summer: 06:00Z is 09:00 local.
  const summer = bucketByJerusalemHour([at("2026-06-15T06:20:00Z", "620.00")]);
  eq("a summer payment lands in the Israeli hour", summer.hours[9], "620.00");
  eq("and nowhere else", summer.hours.filter((h) => h !== "0.00").length, 1);
  eq("the total is the money", summer.total, "620.00");
  eq("the count is the payments", summer.count, 1);

  // Israel is UTC+2 in winter: 06:20Z is 08:20 local, an hour earlier than the
  // same UTC instant in summer. A fixed offset would have put both in 09.
  const winter = bucketByJerusalemHour([at("2026-01-15T06:20:00Z", "500.00")]);
  eq("a winter payment shifts with the offset", winter.hours[8], "500.00");

  // Two payments inside one hour are one bar, not two.
  const sameHour = bucketByJerusalemHour([
    at("2026-06-15T06:05:00Z", "100.00"),
    at("2026-06-15T06:55:00Z", "250.50"),
  ]);
  eq("two payments in one hour add up", sameHour.hours[9], "350.50");
  eq("and are still two payments", sameHour.count, 2);
  eq("the total carries the cents", sameHour.total, "350.50");

  // Several hours across one day stay separate.
  const spread = bucketByJerusalemHour([
    at("2026-06-15T05:00:00Z", "480.00"),
    at("2026-06-15T11:00:00Z", "1180.00"),
    at("2026-06-15T15:00:00Z", "300.00"),
  ]);
  eq("08:00 keeps its own money", spread.hours[8], "480.00");
  eq("14:00 keeps its own money", spread.hours[14], "1180.00");
  eq("18:00 keeps its own money", spread.hours[18], "300.00");
  eq("and the total is all of it", spread.total, "1960.00");

  // The edges of the day belong to the day.
  const edges = bucketByJerusalemHour([
    at("2026-06-14T21:00:00Z", "10.00"), // 00:00 local on the 15th
    at("2026-06-15T20:59:00Z", "20.00"), // 23:59 local on the 15th
  ]);
  eq("midnight is hour 0", edges.hours[0], "10.00");
  eq("one minute to midnight is hour 23", edges.hours[23], "20.00");

  const empty = bucketByJerusalemHour([]);
  eq("a day with no payments is 24 zeros", empty.hours.length, 24);
  eq("a day with no payments totals zero", empty.total, "0.00");
  eq("a day with no payments counts zero", empty.count, 0);
  ok("a zero day is still complete", empty.complete);
}

function comparison() {
  eq("a doubling reads as +100%", monthChangePct(D("2000"), D("1000")), 100);
  eq("a halving reads as −50%", monthChangePct(D("500"), D("1000")), -50);
  eq("8100 against 5200 rounds to +56%", monthChangePct(D("8100"), D("5200")), 56);
  eq("an unchanged month reads as 0%", monthChangePct(D("1000"), D("1000")), 0);
  eq("no previous money means NO comparison", monthChangePct(D("8100"), D("0")), null);
  eq("two empty months still mean no comparison", monthChangePct(D("0"), D("0")), null);
  ok(
    "a missing comparison is null, never a number",
    monthChangePct(D("8100"), D("0")) === null
  );
}

function dates() {
  eq("a real date passes", normalizeDayKey("2026-09-23"), "2026-09-23");
  eq("whitespace is tolerated", normalizeDayKey("  2026-09-23 "), "2026-09-23");
  eq("a leap day in a leap year passes", normalizeDayKey("2028-02-29"), "2028-02-29");
  eq("a day that never existed is refused", normalizeDayKey("2026-02-30"), null);
  eq("the 29th of a common February is refused", normalizeDayKey("2026-02-29"), null);
  eq("month 13 is refused", normalizeDayKey("2026-13-01"), null);
  eq("a slashed date is refused", normalizeDayKey("2026/09/23"), null);
  eq("a timestamp is refused", normalizeDayKey("2026-09-23T10:00:00Z"), null);
  eq("empty means absent", normalizeDayKey(""), null);
  eq("null means absent", normalizeDayKey(null), null);
}

function main() {
  buckets();
  comparison();
  dates();
  console.log(`home-day.verify.test.ts: ok (${checks} checks)`);
}

main();
