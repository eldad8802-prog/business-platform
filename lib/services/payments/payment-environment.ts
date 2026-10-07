/**
 * TEST / SANDBOX / LIVE — where a payment connection points, and what that may
 * cause in Production.
 *
 * The hazard this closes: a business connects a provider's shared TEST account
 * (CardCom's public terminal 1000) in Production, a customer "pays" with a test
 * card, the provider truthfully verifies the test payment — and Dubiz issued a
 * real fiscal receipt for money that does not exist. Nothing about the payment
 * itself is wrong; what is wrong is treating a test account's truth as money.
 *
 * THE RULE, in Production only:
 *   - a connection that is not positively LIVE (TEST, SANDBOX or UNKNOWN) may
 *     not be connected, may not issue payment links, and a payment that still
 *     arrives through one is recorded as what the provider said but its
 *     accounting pauses (no receipt, no allocation) for a person;
 *   - the ONE exception is the pinned Production QA tenant, whose test-terminal
 *     proofs are the point of its existence (qa-webhook-suppression.ts pins the
 *     same id). An owner cannot add themselves to it.
 *
 * Outside Production (local, CI, Preview) nothing here refuses anything: those
 * environments exist to talk to test accounts.
 *
 * UNKNOWN fails safe. An adapter that cannot tell what it is pointed at has not
 * shown it is live, and "probably live" is not a basis for issuing receipts.
 */

import { COLLECTION_QA_BUSINESS_ID } from "./qa-webhook-suppression";
import type {
  ConnectionEnvironment,
  PaymentProviderAdapter,
} from "./providers/payment-provider.types";

export type { ConnectionEnvironment };

type Env = Record<string, string | undefined>;

/** Vercel's own marker for the Production deployment. */
export function isProductionRuntime(env: Env = process.env): boolean {
  return (env.VERCEL_ENV ?? "").trim() === "production";
}

/** The adapter's own classification; an adapter that cannot tell says UNKNOWN. */
export function classifyConnectionEnvironment(
  adapter: Pick<PaymentProviderAdapter, "classifyEnvironment">,
  merchantId: string | null
): ConnectionEnvironment {
  if (typeof adapter.classifyEnvironment !== "function") return "UNKNOWN";
  try {
    return adapter.classifyEnvironment({ merchantId });
  } catch {
    return "UNKNOWN";
  }
}

/**
 * May a connection of this environment carry live-money consequences for this
 * business in this runtime? True outside Production, true for LIVE, true for
 * the pinned QA tenant — false otherwise.
 */
export function isEnvironmentAllowedForBusiness(
  environment: ConnectionEnvironment,
  businessId: number,
  env: Env = process.env
): boolean {
  if (!isProductionRuntime(env)) return true;
  if (environment === "LIVE") return true;
  return businessId === COLLECTION_QA_BUSINESS_ID;
}

/** Hebrew, owner-facing: why a connection or a link was refused. */
export function environmentRefusalMessage(environment: ConnectionEnvironment): string {
  switch (environment) {
    case "TEST":
      return "פרטי החיבור שייכים למסוף בדיקה של חברת הסליקה. במערכת החיה אפשר לחבר רק מסוף אמיתי.";
    case "SANDBOX":
      return "פרטי החיבור שייכים לסביבת בדיקות של חברת הסליקה. במערכת החיה אפשר לחבר רק חשבון אמיתי.";
    default:
      return "לא ניתן לוודא שפרטי החיבור שייכים לחשבון סליקה אמיתי, ולכן החיבור לא נשמר.";
  }
}
