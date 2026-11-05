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
 * And with the switch ON, a foreign currency is still offered or accepted only
 * for ONE kind of collector: a CardCom connection whose business has said that
 * CardCom issues the documents (documentIssuer PROVIDER_ISSUES). Dubiz issues
 * no foreign-currency tax document of its own (#766), so a foreign-currency
 * payment must arrive with CardCom's document — any other provider, or a
 * CardCom connection set to DUBIZ_ISSUES / NOT_CONFIGURED, is ILS only.
 *
 * ILS is the default everywhere and is first in the result whenever it is
 * offerable. No I/O apart from reading that one server variable.
 */
import { ValidationError } from "@/lib/errors";
import { DEFAULT_BASE_CURRENCY, SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/money/currency";
import type { Translator } from "@/lib/i18n/translate";
import { isForeignCurrencyCollectionEnabled } from "./fx-collection-flag";

/** The one provider a foreign-currency request may be raised through. */
export const FOREIGN_CURRENCY_COLLECTION_PROVIDER = "CARDCOM";

/** Who would collect the money: the selected provider and its connection's document decision. */
export interface ForeignCurrencyCollector {
  provider: string;
  documentIssuer: string | null | undefined;
}

/**
 * Why a foreign currency may NOT be collected through this collector, or null
 * when it may. The switch first, so while it is off the refusal is always the
 * switch's, whatever the connection says.
 */
export function foreignCurrencyCollectionRefusal(
  collector: ForeignCurrencyCollector | null | undefined,
  foreignCurrencyEnabled: boolean = isForeignCurrencyCollectionEnabled()
): "FX_COLLECTION_DISABLED" | "FX_REQUIRES_PROVIDER_DOCUMENTS" | null {
  if (!foreignCurrencyEnabled) return "FX_COLLECTION_DISABLED";
  if (
    collector?.provider !== FOREIGN_CURRENCY_COLLECTION_PROVIDER ||
    collector.documentIssuer !== "PROVIDER_ISSUES"
  ) {
    return "FX_REQUIRES_PROVIDER_DOCUMENTS";
  }
  return null;
}

/** True only when the switch is ON, the provider is CardCom and CardCom issues the documents. */
export function isForeignCurrencyAllowedFor(
  collector: ForeignCurrencyCollector | null | undefined,
  foreignCurrencyEnabled: boolean = isForeignCurrencyCollectionEnabled()
): boolean {
  return foreignCurrencyCollectionRefusal(collector, foreignCurrencyEnabled) === null;
}

/**
 * The Dubiz set narrowed by what the provider adapter can encode (registry
 * order: ILS first) — and, unless a foreign currency is allowed for this
 * collector (`isForeignCurrencyAllowedFor`), narrowed further to ILS alone.
 * Fail-closed: without that answer, ILS alone.
 */
export function offerableCurrencies(
  providerSupported: readonly string[] | null | undefined,
  foreignCurrencyAllowed: boolean = false
): CurrencyCode[] {
  const byProvider =
    providerSupported == null
      ? [...SUPPORTED_CURRENCIES]
      : SUPPORTED_CURRENCIES.filter((c) => providerSupported.includes(c));
  return foreignCurrencyAllowed ? byProvider : byProvider.filter((c) => c === DEFAULT_BASE_CURRENCY);
}

/** What the UI may offer when no provider can be resolved yet: the default alone. */
export const DEFAULT_OFFERABLE_CURRENCIES: readonly CurrencyCode[] = Object.freeze([DEFAULT_BASE_CURRENCY]);

export type CurrencyRefusalReason =
  | "NOT_OFFERABLE"
  | "INVOICE_CURRENCY"
  | "FX_COLLECTION_DISABLED"
  | "FX_REQUIRES_PROVIDER_DOCUMENTS";

const REFUSAL_CODE: Readonly<Record<CurrencyRefusalReason, string>> = {
  NOT_OFFERABLE: "UNSUPPORTED_CURRENCY",
  INVOICE_CURRENCY: "CURRENCY_MISMATCH",
  FX_COLLECTION_DISABLED: "FOREIGN_CURRENCY_COLLECTION_DISABLED",
  FX_REQUIRES_PROVIDER_DOCUMENTS: "FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS",
};

/**
 * A payment request asked for a currency it may not be raised in. Still a
 * `ValidationError` (400, `{ error, code }` through `handleError`); it carries
 * the facts the route needs to answer in the viewer's language.
 *
 *   NOT_OFFERABLE          → code UNSUPPORTED_CURRENCY (the money registry's code)
 *   INVOICE_CURRENCY       → code CURRENCY_MISMATCH    (the money engine's code)
 *   FX_COLLECTION_DISABLED → code FOREIGN_CURRENCY_COLLECTION_DISABLED (the kill switch is off)
 *   FX_REQUIRES_PROVIDER_DOCUMENTS → code FOREIGN_CURRENCY_REQUIRES_PROVIDER_DOCUMENTS
 *                            (switch on, but the collector is not CardCom issuing the documents)
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
 * The kill switch, then the collector. A request in any currency other than ILS
 * is refused — whatever the provider supports and whichever way the currency
 * was arrived at (sent by the caller or taken from an invoice) — while the
 * switch is off, and, with it on, unless the collector is CardCom issuing the
 * documents. No collector named counts as "not that collector" (fail-closed).
 * ILS passes without the switch or the collector being consulted.
 */
export function assertForeignCurrencyCollectionAllowed(
  currency: string,
  collector: ForeignCurrencyCollector | null = null,
  foreignCurrencyEnabled: boolean = isForeignCurrencyCollectionEnabled()
): void {
  if (currency === DEFAULT_BASE_CURRENCY) return;
  const refusal = foreignCurrencyCollectionRefusal(collector, foreignCurrencyEnabled);
  if (refusal === null) return;
  throw new PaymentCurrencyNotOfferableError({
    currency,
    offerable: [DEFAULT_BASE_CURRENCY],
    reason: refusal,
    message:
      refusal === "FX_COLLECTION_DISABLED"
        ? `Collecting in ${currency} is switched off. Payment requests are raised in ${DEFAULT_BASE_CURRENCY} only.`
        : `Collecting in ${currency} requires a ${FOREIGN_CURRENCY_COLLECTION_PROVIDER} connection on which ${FOREIGN_CURRENCY_COLLECTION_PROVIDER} issues the documents. Payment requests are raised in ${DEFAULT_BASE_CURRENCY} only.`,
  });
}

/** Refuse a currency outside the Dubiz set or outside what the provider adapter supports. */
export function assertCurrencyOfferable(
  adapter: { provider: string; supportedCurrencies: readonly string[] | null },
  currency: string,
  collector: ForeignCurrencyCollector | null = null
): void {
  // The kill switch and the collector first, so a foreign currency is always
  // refused for the same reason (and code), whatever the adapter supports.
  assertForeignCurrencyCollectionAllowed(currency, collector);
  const offerable = offerableCurrencies(adapter.supportedCurrencies, isForeignCurrencyAllowedFor(collector));
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
          : error.reason === "FX_REQUIRES_PROVIDER_DOCUMENTS"
            ? t("api.payments.foreignCurrencyRequiresProviderDocuments", { currency: error.currency, allowed })
            : t("api.payments.currencyNotOffered", { currency: error.currency, allowed }),
    code: error.code ?? "UNSUPPORTED_CURRENCY",
    offerableCurrencies: error.offerable,
  };
}
