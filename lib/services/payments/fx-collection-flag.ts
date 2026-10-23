/**
 * Kill switch for collecting money in a foreign currency (USD / EUR).
 *
 * FAIL-CLOSED. Foreign-currency collection is ON only when the server variable
 * is exactly the string "true". Unset, empty, "1", "TRUE", " true", "yes" — all
 * OFF. With it off:
 *
 *   - the collection readiness read offers ILS alone, for every business and
 *     every provider (`offerableCurrencies`);
 *   - `createPaymentRequest` refuses any request whose currency is not ILS
 *     (code FOREIGN_CURRENCY_COLLECTION_DISABLED) before a PaymentRequest row,
 *     an audit event or a provider call exists.
 *
 * ILS requests never read it and behave exactly as before. Turning it on is an
 * owner decision, taken only after the CardCom and accountant answers — see
 * docs/payments/FX-COLLECTION-SWITCH.md. Read per call (never cached at module
 * load), the same way `isI18nEnabled` reads DUBIZ_I18N_ENABLED.
 */
export const FX_COLLECTION_FLAG = "DUBIZ_FX_COLLECTION_ENABLED";

export function isForeignCurrencyCollectionEnabled(): boolean {
  return process.env.DUBIZ_FX_COLLECTION_ENABLED === "true";
}
