/**
 * Collection · Payment terms — when an issued invoice is expected to be paid.
 *
 * Pure. No I/O, no Prisma, no dates read from the environment — the caller
 * supplies "now". That keeps every rule here testable and keeps the collection
 * read-model deterministic.
 *
 * WHY THIS EXISTS: before this module the system had no concept of a payment
 * being *expected*. It knew when an invoice was issued and how much was still
 * unallocated, but "this should already have been paid" was not expressible.
 * Without that idea there is nothing for a collection list to select.
 *
 * SCOPE BOUNDARY: this is a collection-only concept. It never touches issuance,
 * numbering, the frozen document snapshot, the PDF, or authority submission. A
 * business that never opens the collection screen is unaffected by it.
 */

/**
 * Fallback when a business never set its own terms.
 *
 * 30 days — the common Israeli commercial norm (שוטף+30) and the conservative
 * choice. The asymmetry matters: showing a debt later than the owner would like
 * costs him a little; asking a customer for money that is not yet due costs him
 * standing with that customer. When in doubt, be late rather than wrong.
 */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;

/** Terms outside this range are treated as unset rather than obeyed. */
export const MIN_PAYMENT_TERMS_DAYS = 0;
export const MAX_PAYMENT_TERMS_DAYS = 365;

import {
  addCalendarDays,
  dayKeyIsBefore,
  dayKeyToStableInstant,
  daysBetweenDayKeys,
  jerusalemDayKey,
} from "@/lib/utils/jerusalem-day";

/**
 * The terms actually in force for a business.
 *
 * A stored value that is null, non-integer, negative or absurd is treated as
 * "not configured" rather than trusted — a bad row must not make the collection
 * list wrong, and it must not throw either.
 */
export function resolvePaymentTermsDays(
  configuredDays: number | null | undefined,
): number {
  if (
    typeof configuredDays !== "number" ||
    !Number.isInteger(configuredDays) ||
    configuredDays < MIN_PAYMENT_TERMS_DAYS ||
    configuredDays > MAX_PAYMENT_TERMS_DAYS
  ) {
    return DEFAULT_PAYMENT_TERMS_DAYS;
  }
  return configuredDays;
}

/**
 * When payment is expected, derived from issuance.
 *
 * שוטף+30 is a promise about DAYS, not about elapsed milliseconds, so it is
 * counted on the Israeli calendar. Adding `30 * 86_400_000` to the issuance
 * instant used to drift by an hour across the March and October clock changes:
 * an invoice issued 20 March at 09:00 came due 19 April at 10:00. Nobody agreed
 * to those terms, and no owner could have explained the extra hour to a
 * customer.
 *
 * Returns null for an invoice that was never issued: a draft has no expectation
 * attached to it, and inventing one would put drafts on a collection list.
 *
 * The returned value identifies the DUE DAY. Its time component is an internal
 * encoding with no meaning — never render it.
 */
export function computeExpectedPaymentDate(
  issuedAt: Date | null | undefined,
  termsDays: number,
): Date | null {
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    return null;
  }
  const dueDay = addCalendarDays(jerusalemDayKey(issuedAt), termsDays);
  return dayKeyToStableInstant(dueDay);
}

/**
 * Has the expected payment day passed?
 *
 * The customer gets the WHOLE due day. They are awaiting payment only once the
 * Israeli calendar has moved past it — not at one minute past the hour of
 * issuance, which is what an instant comparison meant and which took roughly
 * fourteen hours of the final day away from them.
 *
 * Off-by-one here is the difference between a fair reminder and an unfair one.
 */
export function isAwaitingPayment(
  expectedPaymentDate: Date | null,
  now: Date,
): boolean {
  if (expectedPaymentDate === null) return false;
  return dayKeyIsBefore(
    jerusalemDayKey(expectedPaymentDate),
    jerusalemDayKey(now),
  );
}

/**
 * Whole calendar days since payment was expected. Never negative.
 *
 * Presentation only. The owner is shown "since 3 June", not "47 days late" —
 * a count invites a judgement, a date states a fact (Constitution, Article 8).
 * This exists for ordering, not for display.
 */
export function daysAwaiting(
  expectedPaymentDate: Date | null,
  now: Date,
): number {
  if (!isAwaitingPayment(expectedPaymentDate, now)) return 0;
  return daysBetweenDayKeys(
    jerusalemDayKey(expectedPaymentDate as Date),
    jerusalemDayKey(now),
  );
}
