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
 * Over both sits the foreign-currency KILL SWITCH (`./fx-collection-flag`,
 * DUBIZ_FX_COLLECTION_ENABLED, fail-closed): while it is off, ILS is the only
 * currency offered or accepted, whatever the provider could do.
 *
 * ILS is the default everywhere and is first in the result whenever it is
 * offerable. No I/O apart from reading that one server variable.
 */
import { ValidationError } from "@/lib/errors";
import { DEFAULT_BASE_CURRENCY, SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/money/currency";
import type { Translator } from "@/lib/i18n/translate";
import { isForeignCurrencyCollectionEnabled } from "./fx-collection-flag";

/**
 * The Dubiz set narrowed by what the provider adapter can encode (registry
 * order: ILS first) — and, while foreign-currency collection is switched off,
 * narrowed further to ILS alone.
 */
export function offerableCurrencies(
  providerSupported: readonly string[] | null | undefined,
  foreignCurrencyEnabled: boolean = isForeignCurrencyCollectionEnabled()
): CurrencyCode[] {
  const byProvider =
    providerSupported == null
      ? [...SUPPORTED_CURRENCIES]
      : SUPPORTED_CURRENCIES.filter((c) => providerSupported.includes(c));
  return foreignCurrencyEnabled ? byProvider : byProvider.filter((c) => c === DEFAULT_BASE_CURRENCY);
}

/** What the UI may offer when no provider can be resolved yet: the default alone. */
export const DEFAULT_OFFERABLE_CURRENCIES: readonly CurrencyCode[] = Object.freeze([DEFAULT_BASE_CURRENCY]);

export type CurrencyRefusalReason = "NOT_OFFERABLE" | "INVOICE_CURRENCY" | "FX_COLLECTION_DISABLED";

const REFUSAL_CODE: Readonly<Record<CurrencyRefusalReason, string>> = {
  NOT_OFFERABLE: "UNSUPPORTED_CURRENCY",
  INVOICE_CURRENCY: "CURRENCY_MISMATCH",
  FX_COLLECTION_DISABLED: "FOREIGN_CURRENCY_COLLECTION_DISABLED",
};

/**
 * A payment request asked for a currency it may not be raised in. Still a
 * `ValidationError` (400, `{ error, code }` through `handleError`); it carries
 * the facts the route needs to answer in the viewer's language.
 *
 *   NOT_OFFERABLE          → code UNSUPPORTED_CURRENCY (the money registry's code)
 *   INVOICE_CURRENCY       → code CURRENCY_MISMATCH    (the money engine's code)
 *   FX_COLLECTION_DISABLED → code FOREIGN_CURRENCY_COLLECTION_DISABLED (the kill switch is off)
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
    this.code = REFUSAL_CODE[input.reason];
    this.currency = input.currency;
    this.offerable = input.offerable;
    this.reason = input.reason;
  }
}

/**
 * The kill switch. While foreign-currency collection is off, a request in any
 * currency other than ILS is refused — whatever the provider supports and
 * whichever way the currency was arrived at (sent by the caller or taken from
 * an invoice). ILS passes without the switch being consulted.
 */
export function assertForeignCurrencyCollectionAllowed(
  currency: string,
  foreignCurrencyEnabled: boolean = isForeignCurrencyCollectionEnabled()
): void {
  if (currency === DEFAULT_BASE_CURRENCY || foreignCurrencyEnabled) return;
  throw new PaymentCurrencyNotOfferableError({
    currency,
    offerable: [DEFAULT_BASE_CURRENCY],
    reason: "FX_COLLECTION_DISABLED",
    message: `Collecting in ${currency} is switched off. Payment requests are raised in ${DEFAULT_BASE_CURRENCY} only.`,
  });
}

/** Refuse a currency outside the Dubiz set or outside what the provider adapter supports. */
export function assertCurrencyOfferable(
  adapter: { provider: string; supportedCurrencies: readonly string[] | null },
  currency: string
): void {
  // The kill switch first, so a foreign currency is always refused for the
  // same reason (and code) while it is off, whatever the adapter supports.
  assertForeignCurrencyCollectionAllowed(currency);
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
        : error.reason === "FX_COLLECTION_DISABLED"
          ? t("api.payments.foreignCurrencyCollectionDisabled", { currency: error.currency, allowed })
          : t("api.payments.currencyNotOffered", { currency: error.currency, allowed }),
    code: error.code ?? "UNSUPPORTED_CURRENCY",
    offerableCurrencies: error.offerable,
  };
}
