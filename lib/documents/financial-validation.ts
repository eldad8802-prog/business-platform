// Shared financial-amount validation — single source of truth used by both the
// server approve path and the client review surface, so a value can never be
// blocked in one place but shown as trustworthy in the other.
//
// Scope is deliberately small: hard sanity on the amount itself (positive,
// finite, within a reasonable per-document ceiling) plus an advisory VAT
// triangle check. It does NOT try to re-derive the "correct" amount.

// Upper bound for a single document's headline amount. Above this we refuse to
// silently store and ask the user to confirm — a guard against OCR reading a
// document/reference number or a concatenated string as money. Generous enough
// not to block legitimate large invoices.
export const FINANCIAL_AMOUNT_MAX = 10_000_000;

export type AmountValidationCode =
  | "ok"
  | "not_finite"
  | "non_positive"
  | "too_large";

export type AmountValidationResult = {
  ok: boolean;
  code: AmountValidationCode;
  // User-facing Hebrew message, null when ok. Explains WHY so the user can act
  // instead of guessing why a save was refused.
  message: string | null;
};

export function validateFinancialAmount(amount: unknown): AmountValidationResult {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return {
      ok: false,
      code: "not_finite",
      message: "לא זוהה סכום תקין. צריך להשלים סכום מספרי לפני השמירה.",
    };
  }

  if (amount <= 0) {
    return {
      ok: false,
      code: "non_positive",
      message: "הסכום חייב להיות גדול מאפס. בדוק את הסכום שזוהה במסמך.",
    };
  }

  if (amount > FINANCIAL_AMOUNT_MAX) {
    return {
      ok: false,
      code: "too_large",
      message:
        "הסכום שזוהה חריג וגבוה מהצפוי למסמך בודד. ודא שזה הסכום הנכון לפני השמירה.",
    };
  }

  return { ok: true, code: "ok", message: null };
}

export function isValidFinancialAmount(amount: unknown): boolean {
  return validateFinancialAmount(amount).ok;
}

// Advisory VAT triangle check: when subtotal + VAT + total are all present and
// positive, they should reconcile (subtotal + vat ≈ total). A mismatch beyond a
// small tolerance is a strong signal that at least one figure was misread, so
// the document should not be shown as high-confidence. Returns null when there
// is not enough data to judge (no false positives on partial extractions).
export function checkVatConsistency(input: {
  total: number | null | undefined;
  subtotal: number | null | undefined;
  vat: number | null | undefined;
}): { consistent: boolean } | null {
  const total = input.total;
  const subtotal = input.subtotal;
  const vat = input.vat;

  if (
    typeof total !== "number" ||
    typeof subtotal !== "number" ||
    typeof vat !== "number" ||
    !Number.isFinite(total) ||
    !Number.isFinite(subtotal) ||
    !Number.isFinite(vat) ||
    total <= 0 ||
    subtotal <= 0 ||
    vat <= 0
  ) {
    return null;
  }

  // Tolerance absorbs rounding (agorot) and tiny OCR noise: max of 1₪ or 2% of
  // the total. Anything larger is a genuine inconsistency, not rounding.
  const tolerance = Math.max(1, total * 0.02);
  const consistent = Math.abs(subtotal + vat - total) <= tolerance;
  return { consistent };
}

// Plausibility window for an extracted document date relative to "now". A
// document dated far in the future (beyond a small clock-skew grace) or absurdly
// old is almost certainly a misread, and should be flagged for review rather
// than trusted. Kept lenient so legitimate backdated documents still pass.
export function isPlausibleDocumentDate(
  date: Date | string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!date) return false;
  const d = date instanceof Date ? date : new Date(date);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return false;

  const FUTURE_GRACE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days for timezone skew
  const PAST_GRACE_MS = 12 * 365 * 24 * 60 * 60 * 1000; // ~12 years

  if (ms > now.getTime() + FUTURE_GRACE_MS) return false;
  if (ms < now.getTime() - PAST_GRACE_MS) return false;
  return true;
}
