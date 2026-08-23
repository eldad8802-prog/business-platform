/**
 * Coupon benefit — the single validation authority for what a coupon may say.
 *
 * WHY THIS EXISTS (COUPON-05/06/07/12):
 * `Offer` stores a benefit *sentence* (`title` / `customerBenefitText`), not
 * structured economics — there is no discountType/value/scope column, and per
 * `coupon-campaign-architecture-decision-v1.md` §2 we are not adding one in v1.
 * So the parts the owner picks are validated here, composed into a canonical
 * sentence here, and only then persisted. Both the wizard and the API import
 * this module, so client and server can never disagree about what is valid, and
 * the stored sentence can never be a half-built string like "50₪ על קטגוריה".
 *
 * Pure: no DB, no env, no clock. Unit-testable in isolation.
 */

export type BenefitType =
  | "pct"
  | "amt"
  | "price"
  | "giftProduct"
  | "giftService"
  | "more"
  | "other";

export const BENEFIT_TYPES: readonly BenefitType[] = [
  "pct",
  "amt",
  "price",
  "giftProduct",
  "giftService",
  "more",
  "other",
];

export function isBenefitType(value: unknown): value is BenefitType {
  return typeof value === "string" && (BENEFIT_TYPES as readonly string[]).includes(value);
}

/** Free-text benefit values (gift/more/other) — a real product or service name. */
const TEXT_MIN = 2;
const TEXT_MAX = 60;

/** Money ceiling for a single coupon. Above this it is almost certainly a typo. */
const MONEY_MAX = 100_000;

/** Scope is typed by the owner, never picked from a selector we cannot resolve. */
const SCOPE_MAX = 40;

/** The whole-business scope — the default, and the only non-typed scope. */
export const SCOPE_WHOLE_BUSINESS = "כל העסק";

export const DESCRIPTION_MAX = 200;

export type BenefitInput = {
  benefitType: BenefitType;
  /** Raw owner input: a number for pct/amt/price, free text otherwise. */
  value: string;
  /** `SCOPE_WHOLE_BUSINESS` or an owner-typed product/service name. */
  scope: string;
};

export type FieldError = { field: "benefitType" | "value" | "scope"; message: string };

/** Money with at most 2 decimals — no scientific notation, no thousands separators. */
const MONEY_RE = /^\d{1,6}(\.\d{1,2})?$/;

function parseMoney(raw: string): number | null {
  const trimmed = raw.trim();
  if (!MONEY_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate the benefit parts. Returns every problem at once so the wizard can
 * mark the offending field instead of firing a generic toast (COUPON-07 UX).
 */
export function validateBenefit(input: BenefitInput): FieldError[] {
  const errors: FieldError[] = [];

  if (!isBenefitType(input.benefitType)) {
    return [{ field: "benefitType", message: "סוג הטבה לא נתמך" }];
  }

  const value = (input.value ?? "").trim();

  switch (input.benefitType) {
    case "pct": {
      // Integer only: "20.5% הנחה" is not a thing a counter can honour.
      if (!/^\d{1,3}$/.test(value)) {
        errors.push({ field: "value", message: "יש להזין אחוז הנחה שלם" });
        break;
      }
      const pct = Number(value);
      if (pct < 1 || pct > 100) {
        errors.push({ field: "value", message: "אחוז ההנחה חייב להיות בין 1 ל‑100" });
      }
      break;
    }
    case "amt":
    case "price": {
      const money = parseMoney(value);
      if (money === null) {
        errors.push({ field: "value", message: "יש להזין סכום תקין (עד שתי ספרות אחרי הנקודה)" });
        break;
      }
      if (money <= 0) {
        errors.push({ field: "value", message: "הסכום חייב להיות גדול מ‑0" });
      } else if (money > MONEY_MAX) {
        errors.push({ field: "value", message: `הסכום חורג מהמותר (עד ${MONEY_MAX.toLocaleString("he-IL")}₪)` });
      }
      break;
    }
    case "giftProduct":
    case "giftService":
    case "more":
    case "other": {
      if (value.length < TEXT_MIN) {
        errors.push({ field: "value", message: "יש לתאר את ההטבה" });
      } else if (value.length > TEXT_MAX) {
        errors.push({ field: "value", message: `תיאור ההטבה ארוך מדי (עד ${TEXT_MAX} תווים)` });
      }
      break;
    }
  }

  const scope = (input.scope ?? "").trim();
  if (!scope) {
    errors.push({ field: "scope", message: "יש לבחור על מה ההטבה חלה" });
  } else if (scope !== SCOPE_WHOLE_BUSINESS && scope.length > SCOPE_MAX) {
    errors.push({ field: "scope", message: `הטקסט ארוך מדי (עד ${SCOPE_MAX} תווים)` });
  }

  return errors;
}

/** Normalized money display: 50 → "50", 49.90 → "49.9", 49.99 → "49.99". */
function money(raw: string): string {
  const n = parseMoney(raw);
  return n === null ? raw.trim() : String(n);
}

/** The benefit half of the sentence — never emitted with a placeholder. */
export function benefitSegment(type: BenefitType, rawValue: string): string {
  const value = (rawValue ?? "").trim();
  switch (type) {
    case "pct":
      // Normalized, not echoed: "007" passes validation (it is 7, which is in
      // range) but would otherwise be published to customers verbatim as
      // "007% הנחה". Money already goes through `money()`; percent needs the
      // same treatment.
      return `${Number(value)}% הנחה`;
    case "amt":
      return `${money(value)}₪ הנחה`;
    case "price":
      return `במחיר ${money(value)}₪`;
    case "giftProduct":
    case "giftService":
      return `${value} מתנה`;
    case "more":
    case "other":
      return value;
  }
}

/**
 * The canonical benefit sentence that gets persisted (COUPON-12).
 *
 * Only ever called on input that passed `validateBenefit`, so it cannot produce
 * the audit's "קפה הפוך מתנה על כל העסק" / "50₪ על קטגוריה" artefacts: the
 * scope half is a real owner-typed noun, and "כל העסק" reads correctly.
 */
export function composeBenefitSentence(input: BenefitInput): string {
  const segment = benefitSegment(input.benefitType, input.value);
  const scope = (input.scope ?? "").trim();
  return scope ? `${segment} על ${scope}` : segment;
}
