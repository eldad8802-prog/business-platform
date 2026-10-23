/**
 * /collection/new · which currency the payment request is raised in.
 *
 * Pure, so the rule that keeps an ILS-only business's screen exactly as it was
 * is testable without rendering React:
 *
 *   - an invoice-backed request is ALWAYS in the invoice's currency — no choice;
 *   - a standalone request offers a choice only when the business can be
 *     charged in more than one currency (readiness.offerableCurrencies, which
 *     the server derives from the Dubiz set and the connected provider);
 *   - with no choice shown the currency is derived exactly as before
 *     (invoice → thread → ILS); with a choice shown ILS is preselected.
 */
import { DEFAULT_BASE_CURRENCY, isSupportedCurrency, type CurrencyCode } from "@/lib/money/currency";

/** Defensive read of the readiness field: anything missing or malformed means ILS alone. */
export function offerableFrom(value: unknown): CurrencyCode[] {
  if (!Array.isArray(value)) return [DEFAULT_BASE_CURRENCY];
  const list = value.filter(isSupportedCurrency).filter((c, i, all) => all.indexOf(c) === i);
  return list.length > 0 ? list : [DEFAULT_BASE_CURRENCY];
}

/** The choice appears only for a standalone request, and only when there is something to choose. */
export function showCurrencyChoice(input: { standalone: boolean; offerable: readonly CurrencyCode[] }): boolean {
  return input.standalone && input.offerable.length > 1;
}

export function requestCurrency(input: {
  invoiceCurrency: string | null | undefined;
  threadCurrency: string | null | undefined;
  /** What the owner picked, or null when they have not touched the choice. */
  chosen: CurrencyCode | null;
  choiceShown: boolean;
  offerable: readonly CurrencyCode[];
}): string {
  if (input.invoiceCurrency != null) return input.invoiceCurrency;
  if (input.choiceShown) {
    return input.chosen && input.offerable.includes(input.chosen) ? input.chosen : DEFAULT_BASE_CURRENCY;
  }
  // Unchanged from before the choice existed.
  return input.threadCurrency ?? DEFAULT_BASE_CURRENCY;
}
