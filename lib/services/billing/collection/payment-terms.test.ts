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
  const expected = computeExpectedPaymentDate(ISSUED, 30);
  ok(
    "expected date = issuedAt + terms",
    expected?.getTime() === day(30).getTime(),
  );
  ok(
    "zero terms means due on the issue instant",
    computeExpectedPaymentDate(ISSUED, 0)?.getTime() === ISSUED.getTime(),
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
  ok("one ms after: awaiting", isAwaitingPayment(expected, new Date(day(30).getTime() + 1)) === true);
  ok("well after: awaiting", isAwaitingPayment(expected, day(45)) === true);
  ok("no expected date is never awaiting", isAwaitingPayment(null, day(999)) === false);

  // --- days awaiting: ordering only, never shown as "47 days late" ---
  ok("not awaiting counts zero", daysAwaiting(expected, day(10)) === 0);
  ok("never negative", daysAwaiting(expected, day(0)) === 0);
  ok("counts whole days", daysAwaiting(expected, day(45)) === 15);
  ok("partial day rounds down", daysAwaiting(expected, new Date(day(31).getTime() - 1)) === 0);

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
