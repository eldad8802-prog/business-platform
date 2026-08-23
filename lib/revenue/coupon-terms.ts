/**
 * Coupon terms + validity — the v1 rules a coupon may actually state.
 *
 * WHY THIS IS SMALLER THAN THE OLD UI (COUPON-06):
 * The wizard used to offer four condition chips. Two of them were promises the
 * system cannot keep and were removed rather than shipped as decoration:
 *
 *   • "פעם אחת ללקוח"  — requires consumer identity, which does not exist
 *     anywhere in the model. Ruled out for now by
 *     `coupon-c5-quota-semantics-decision-v1.md` §0. It was also redundant:
 *     a coupon token is single-redemption by construction
 *     (`RedemptionEvent.couponId @unique`).
 *   • "סניף מסוים"     — there is no branch/location entity to point at.
 *
 * What survives is what a human at the counter can genuinely honour when the
 * QR is scanned, since redemption in v1 is a person accepting the coupon:
 *
 *   • "מינימום רכישה"  — kept, but now REQUIRES an amount (the audit found it
 *     shipping with no value at all).
 *   • "לקוחות חדשים"   — kept: a stated term the business applies at the till.
 *
 * Pure: no DB, no env. `now` is always injected so validity is testable.
 */

const MONEY_RE = /^\d{1,6}(\.\d{1,2})?$/;
const MIN_PURCHASE_MAX = 100_000;

/** A coupon may not be valid for less than a day or more than a year. */
export const VALIDITY_MIN_DAYS = 1;
export const VALIDITY_MAX_DAYS = 365;

/**
 * The furthest date the picker may offer, as `YYYY-MM-DD`.
 *
 * Deliberately one day inside `VALIDITY_MAX_DAYS`. The server compares an
 * *instant* (`now + 365 days`) against the coupon's end-of-day in Israel, so a
 * date exactly 365 days out resolves to ~23:59 local — later in the day than
 * the cutoff, and rejected. An adversarial pass caught this: picking the last
 * date the calendar allowed returned a 400. The picker and the validator now
 * derive from the same constant instead of drifting apart.
 */
export function maxValidUntilDate(from: Date = new Date()): string {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + VALIDITY_MAX_DAYS - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type CouponTerms = {
  /** Minimum spend in ₪, or null when the term is off. */
  minPurchase: number | null;
  newCustomersOnly: boolean;
};

export type TermsFieldError = { field: "minPurchase" | "validUntil"; message: string };

export const EMPTY_TERMS: CouponTerms = { minPurchase: null, newCustomersOnly: false };

/**
 * Parse the raw terms payload. `minPurchaseRaw` is the owner's typed string;
 * `minPurchaseEnabled` is the chip state, so an enabled-but-empty amount is a
 * validation error rather than a silently dropped term.
 */
export function validateTerms(input: {
  minPurchaseEnabled: boolean;
  minPurchaseRaw: string;
}): { terms: CouponTerms; errors: TermsFieldError[] } {
  const errors: TermsFieldError[] = [];
  let minPurchase: number | null = null;

  if (input.minPurchaseEnabled) {
    const raw = (input.minPurchaseRaw ?? "").trim();
    if (!MONEY_RE.test(raw)) {
      errors.push({ field: "minPurchase", message: "יש להזין סכום מינימום תקין" });
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push({ field: "minPurchase", message: "סכום המינימום חייב להיות גדול מ‑0" });
      } else if (n > MIN_PURCHASE_MAX) {
        errors.push({ field: "minPurchase", message: "סכום המינימום חורג מהמותר" });
      } else {
        minPurchase = n;
      }
    }
  }

  return { terms: { minPurchase, newCustomersOnly: false }, errors };
}

/** Human terms line stored on the offer description and shown on the coupon. */
export function composeTermsText(terms: CouponTerms): string {
  const parts: string[] = [];
  if (terms.minPurchase !== null) parts.push(`בקנייה מעל ${terms.minPurchase.toLocaleString("he-IL")}₪`);
  if (terms.newCustomersOnly) parts.push("ללקוחות חדשים בלבד");
  return parts.join(" · ");
}

/**
 * Validate the coupon's end date (COUPON-08).
 *
 * There is no `startsAt` column on `Offer`, so v1 has no scheduled-in-the-future
 * coupon and no SCHEDULED state — a published coupon is live immediately. Only
 * the end boundary is a real, stored value (`Offer.validUntil` → `Coupon.expiresAt`).
 */
export function validateValidUntil(validUntil: Date, now: Date): TermsFieldError[] {
  if (Number.isNaN(validUntil.getTime())) {
    return [{ field: "validUntil", message: "תאריך סיום לא תקין" }];
  }
  if (validUntil <= now) {
    return [{ field: "validUntil", message: "תאריך הסיום חייב להיות בעתיד" }];
  }
  const maxEnd = new Date(now.getTime() + VALIDITY_MAX_DAYS * 24 * 60 * 60 * 1000);
  if (validUntil > maxEnd) {
    return [{ field: "validUntil", message: `תאריך הסיום רחוק מדי (עד ${VALIDITY_MAX_DAYS} ימים)` }];
  }
  return [];
}

/**
 * End-of-day in Israel for a `YYYY-MM-DD` the owner picked (COUPON-08).
 *
 * A date picked in Israel must expire at 23:59:59.999 *Israel time*, not UTC —
 * otherwise a coupon picked for "today" dies 2–3 hours early. Israel is UTC+2
 * (IST) / UTC+3 (IDT); the offset is resolved from the zone itself rather than
 * hardcoded, so DST transitions stay correct.
 */
export function israelEndOfDay(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return new Date(NaN);
  const [, y, m, d] = match;

  // Start from the naive UTC instant, then subtract Israel's offset at that
  // instant. Two passes settle the case where the guess lands on the other
  // side of a DST boundary.
  let guess = new Date(`${y}-${m}-${d}T23:59:59.999Z`);
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = israelOffsetMinutes(guess);
    guess = new Date(Date.parse(`${y}-${m}-${d}T23:59:59.999Z`) - offsetMinutes * 60_000);
  }
  return guess;
}

/** Israel's UTC offset in minutes at a given instant (120 in IST, 180 in IDT). */
function israelOffsetMinutes(at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(at).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}
