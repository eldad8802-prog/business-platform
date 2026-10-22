/**
 * Which currencies a payment request may be raised in.
 *
 * Two limits, both always applied, neither inferred from the other:
 *
 *   1. the Dubiz currency registry (`lib/money/currency` — ILS, USD, EUR). A
 *      currency outside it cannot be presented, computed or reconciled by the
 *      rest of the product, so no request is ever raised in one;
 *   2. the selected provider adapter's `supportedCurrencies`. A concrete list is
 *      exhaustive (SEC-05); `null` means the adapter forwards the ISO code
 *      unchanged and adds no restriction of its own — the Dubiz set still holds.
 *
 * ILS is the default everywhere and is first in the result whenever it is
 * offerable. Pure: no I/O, safe to import anywhere.
 */
import { ValidationError } from "@/lib/errors";
import { DEFAULT_BASE_CURRENCY, SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/money/currency";
import type { Translator } from "@/lib/i18n/translate";

/** The Dubiz set narrowed by what the provider adapter can encode (registry order: ILS first). */
export function offerableCurrencies(
  providerSupported: readonly string[] | null | undefined
): CurrencyCode[] {
  if (providerSupported == null) return [...SUPPORTED_CURRENCIES];
  return SUPPORTED_CURRENCIES.filter((c) => providerSupported.includes(c));
}

/** What the UI may offer when no provider can be resolved yet: the default alone. */
export const DEFAULT_OFFERABLE_CURRENCIES: readonly CurrencyCode[] = Object.freeze([DEFAULT_BASE_CURRENCY]);

export type CurrencyRefusalReason = "NOT_OFFERABLE" | "INVOICE_CURRENCY";

/**
 * A payment request asked for a currency it may not be raised in. Still a
 * `ValidationError` (400, `{ error, code }` through `handleError`); it carries
 * the facts the route needs to answer in the viewer's language.
 *
 *   NOT_OFFERABLE    → code UNSUPPORTED_CURRENCY (the money registry's code)
 *   INVOICE_CURRENCY → code CURRENCY_MISMATCH    (the money engine's code)
 */
export class PaymentCurrencyNotOfferableError extends ValidationError {
  readonly currency: string;
  readonly offerable: readonly string[];
  readonly reason: CurrencyRefusalReason;

  constructor(input: {
    currency: string;
    offerable: readonly string[];
    reason: CurrencyRefusalReason;
    message: string;
  }) {
    super(input.message);
    this.name = "PaymentCurrencyNotOfferableError";
    this.code = input.reason === "INVOICE_CURRENCY" ? "CURRENCY_MISMATCH" : "UNSUPPORTED_CURRENCY";
    this.currency = input.currency;
    this.offerable = input.offerable;
    this.reason = input.reason;
  }
}

/** Refuse a currency outside the Dubiz set or outside what the provider adapter supports. */
export function assertCurrencyOfferable(
  adapter: { provider: string; supportedCurrencies: readonly string[] | null },
  currency: string
): void {
  const offerable = offerableCurrencies(adapter.supportedCurrencies);
  if ((offerable as readonly string[]).includes(currency)) return;
  throw new PaymentCurrencyNotOfferableError({
    currency,
    offerable,
    reason: "NOT_OFFERABLE",
    message: `${adapter.provider} cannot be charged in ${currency}. Supported: ${offerable.join(", ")}.`,
  });
}

/** An invoice-backed request is raised in the invoice's own currency — never another. */
export function assertInvoiceCurrency(documentCurrency: string, requested: string): void {
  if (documentCurrency.toUpperCase() === requested.toUpperCase()) return;
  throw new PaymentCurrencyNotOfferableError({
    currency: requested,
    offerable: [documentCurrency.toUpperCase()],
    reason: "INVOICE_CURRENCY",
    message: `Currency mismatch: the document is in ${documentCurrency} and the payment was requested in ${requested}.`,
  });
}

/**
 * The 400 body a route returns for this refusal: the usual `{ error, code }`,
 * the message in the viewer's language, plus the currencies that ARE allowed.
 */
export function paymentCurrencyRefusalBody(
  error: PaymentCurrencyNotOfferableError,
  t: Translator
): { error: string; code: string; offerableCurrencies: readonly string[] } {
  const allowed = error.offerable.join(", ");
  return {
    error:
      error.reason === "INVOICE_CURRENCY"
        ? t("api.payments.currencyMustMatchInvoice", { currency: allowed })
        : t("api.payments.currencyNotOffered", { currency: error.currency, allowed }),
    code: error.code ?? "UNSUPPORTED_CURRENCY",
    offerableCurrencies: error.offerable,
  };
}
