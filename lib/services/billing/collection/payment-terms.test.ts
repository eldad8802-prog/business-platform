/**
 * Collection · payment terms verify (pure — no DB, no network):
 *   npx tsx lib/services/billing/collection/payment-terms.test.ts
 *
 * Covers the one idea this module introduces: an issued invoice can be
 * *expected* to have been paid by a certain date, and that expectation is what
 * a collection list selects on.
 */

import {
  DEFAULT_PAYMENT_TERMS_DAYS,
  MAX_PAYMENT_TERMS_DAYS,
  computeExpectedPaymentDate,
  daysAwaiting,
  isAwaitingPayment,
  resolvePaymentTermsDays,
} from "./payment-terms";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const ISSUED = new Date("2026-06-03T10:00:00.000Z");
const day = (n: number) => new Date(ISSUED.getTime() + n * 86_400_000);

function run() {
  // --- terms resolution: a bad stored value must never make the list wrong ---
  ok("configured value is honoured", resolvePaymentTermsDays(14) === 14);
  ok("zero is honoured (due on issue)", resolvePaymentTermsDays(0) === 0);
  ok(
    "upper bound is honoured",
    resolvePaymentTermsDays(MAX_PAYMENT_TERMS_DAYS) === MAX_PAYMENT_TERMS_DAYS,
  );
  ok("null falls back", resolvePaymentTermsDays(null) === DEFAULT_PAYMENT_TERMS_DAYS);
  ok(
    "undefined falls back",
    resolvePaymentTermsDays(undefined) === DEFAULT_PAYMENT_TERMS_DAYS,
  );
  ok("negative falls back", resolvePaymentTermsDays(-5) === DEFAULT_PAYMENT_TERMS_DAYS);
  ok(
    "absurd value falls back",
    resolvePaymentTermsDays(99_999) === DEFAULT_PAYMENT_TERMS_DAYS,
  );
  ok(
    "non-integer falls back",
    resolvePaymentTermsDays(14.5) === DEFAULT_PAYMENT_TERMS_DAYS,
  );
  ok(
    "NaN falls back",
    resolvePaymentTermsDays(Number.NaN) === DEFAULT_PAYMENT_TERMS_DAYS,
  );
  ok("default is 30", DEFAULT_PAYMENT_TERMS_DAYS === 30);

  // --- expected date derives from issuance, never from creation ---
  //
  // The expectation is a DAY on the Israeli calendar, not an instant. The
  // returned Date identifies that day; its time component is an internal
  // encoding and is never asserted on or displayed.
  const expected = computeExpectedPaymentDate(ISSUED, 30);
  ok(
    "expected day = the issuance day plus the terms, on the calendar",
    jerusalemDayKey(expected as Date) === "2026-07-03",
  );
  ok(
    "zero terms means due on the day of issue",
    jerusalemDayKey(computeExpectedPaymentDate(ISSUED, 0) as Date) ===
      jerusalemDayKey(ISSUED),
  );

  // The regression that motivated calendar semantics: a span crossing the
  // spring clock change must still be exactly 30 days, not 30 days and an hour.
  const springIssued = new Date("2026-03-20T07:00:00.000Z"); // 09:00 Israel
  ok(
    "a 30-day span across the DST change lands on the right day",
    jerusalemDayKey(computeExpectedPaymentDate(springIssued, 30) as Date) ===
      "2026-04-19",
  );

  // A draft has no expectation. Inventing one would put drafts on the list.
  ok("never-issued has no expected date", computeExpectedPaymentDate(null, 30) === null);
  ok(
    "undefined issuedAt has no expected date",
    computeExpectedPaymentDate(undefined, 30) === null,
  );
  ok(
    "invalid date has no expected date",
    computeExpectedPaymentDate(new Date("nope"), 30) === null,
  );

  // --- awaiting: the boundary is where fairness lives ---
  ok("before the date: not awaiting", isAwaitingPayment(expected, day(29)) === false);
  ok(
    "exactly on the date: NOT awaiting — the customer still has that day",
    isAwaitingPayment(expected, day(30)) === false,
  );
  // The customer gets the WHOLE due day. Under the previous instant comparison
  // an invoice issued at 10:00 UTC turned into a debt at 10:00 UTC on the due
  // day, taking the rest of that day away from the customer. These three
  // assertions are the fix, stated as behaviour.
  ok(
    "one minute past the issuance hour on the due day: still NOT awaiting",
    isAwaitingPayment(expected, new Date(day(30).getTime() + 60_000)) === false,
  );
  ok(
    "late evening of the due day, Israel time: still NOT awaiting",
    isAwaitingPayment(expected, new Date("2026-07-03T20:30:00.000Z")) === false,
  );
  ok(
    "first minute of the next Israeli day: awaiting",
    // 21:05 UTC on 3 July is 00:05 on 4 July in Israel (UTC+3).
    isAwaitingPayment(expected, new Date("2026-07-03T21:05:00.000Z")) === true,
  );
  ok("well after: awaiting", isAwaitingPayment(expected, day(45)) === true);
  ok("no expected date is never awaiting", isAwaitingPayment(null, day(999)) === false);

  // --- days awaiting: ordering only, never shown as "47 days late" ---
  ok("not awaiting counts zero", daysAwaiting(expected, day(10)) === 0);
  ok("never negative", daysAwaiting(expected, day(0)) === 0);
  ok("counts whole calendar days", daysAwaiting(expected, day(45)) === 15);
  ok("the due day itself counts zero", daysAwaiting(expected, day(30)) === 0);
  ok("the day after the due day counts one", daysAwaiting(expected, day(31)) === 1);

  // --- end to end: an unconfigured business still gets a working list ---
  const terms = resolvePaymentTermsDays(null);
  const due = computeExpectedPaymentDate(ISSUED, terms);
  ok(
    "unconfigured business: not awaiting on day 20",
    isAwaitingPayment(due, day(20)) === false,
  );
  ok(
    "unconfigured business: awaiting on day 31",
    isAwaitingPayment(due, day(31)) === true,
  );

  console.log(
    failed === 0
      ? "\nCollection · payment terms: ALL CHECKS PASSED"
      : `\nCollection · payment terms: ${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

run();
