/**
 * Collection · small pure helpers shared by the screen.
 *
 * They live here rather than inside the components for one reason: a wrong
 * phone number sends the owner's message to a stranger, and that has to be
 * testable without rendering React.
 */

const CURRENCY_SYMBOL: Record<string, string> = {
  ILS: "₪",
  USD: "$",
  EUR: "€",
};

/** Falls back to the code itself — an unknown currency is shown, never dropped. */
export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] ?? currency;
}

/**
 * An Israeli phone in the form `wa.me` expects: digits only, country code, no
 * leading zero.
 *
 * Returns null rather than guessing whenever the input cannot be trusted. The
 * screen then offers "copy" instead of a send button — a message the owner
 * sends himself is always better than one sent to the wrong number.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  // A leading "+" is a country code the caller already supplied; any other
  // non-digit is formatting noise (spaces, dashes, parentheses).
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 0) return null;

  if (digits.startsWith("972")) {
    // 972 + 9 subscriber digits at minimum.
    return digits.length >= 11 ? digits : null;
  }

  if (trimmed.startsWith("+")) {
    // Some other country. Trust the caller's country code, verify only length.
    return digits.length >= 10 ? digits : null;
  }

  if (digits.startsWith("0")) {
    // Local Israeli form: 0-prefixed, 9 or 10 digits total.
    if (digits.length < 9 || digits.length > 10) return null;
    return `972${digits.slice(1)}`;
  }

  // No country code and no leading zero — we cannot tell what this is.
  return null;
}
