/**
 * Which payment providers are ACTIVE CAPABILITIES in this application.
 *
 * This is a capability switch, not a deletion. The adapters, descriptors,
 * Prisma enum values and stored-credential shapes for disabled providers stay
 * exactly where they are, so any historical record would remain readable and a
 * future re-enablement is a one-line change here rather than an archaeology
 * project.
 *
 * CASA Wave E — PayPal and Tranzila were disabled because they were live,
 * unauthenticated webhook consumers whose only "verification" was a static
 * token compared with `===`, while production carried **zero** rows for either
 * provider in every provider-keyed table (connections, requests, transactions,
 * webhook events, routing). Rather than invent HMAC verification for providers
 * nobody uses, the capability itself was removed from the exposed surface.
 *
 * Two consequences are deliberate:
 *
 *   - Disabling a webhook WITHOUT disabling the matching connect path would be
 *     worse than doing nothing: a business could connect the provider, take a
 *     real payment, and never receive the callback that confirms it. So the
 *     same switch gates the connect path and the provider catalogue that feeds
 *     the settings UI.
 *   - The gate lives server-side. Removing an option from the UI hides it; it
 *     does not stop a direct API call.
 *
 * CardCom is unaffected and remains the active provider. WhatsApp is a
 * different integration entirely and is not governed by this module.
 */
import type { PaymentProvider } from "../payments.types";

/**
 * Providers retained in code and schema but NOT offered as live capabilities.
 * Adding a provider here disables: inbound webhooks, new connections, and its
 * appearance in the provider catalogue.
 */
export const DISABLED_PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  "PAYPAL",
  "TRANZILA",
] as const;

/** True when the provider is an active capability. */
export function isPaymentProviderEnabled(provider: string): boolean {
  return !DISABLED_PAYMENT_PROVIDERS.includes(provider as PaymentProvider);
}

/**
 * Raised when a disabled provider is reached through a path that would
 * otherwise create or process state. Carries no provider detail beyond the key
 * itself — there is nothing sensitive here, but the message is shaped for a
 * user-facing 4xx rather than a stack trace.
 */
export class PaymentProviderDisabledError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Payment provider is not available: ${provider}`);
    this.name = "PaymentProviderDisabledError";
    this.provider = provider;
  }
}

/** Fail-closed assertion for any path that would create or mutate state. */
export function assertPaymentProviderEnabled(provider: string): void {
  if (!isPaymentProviderEnabled(provider)) {
    throw new PaymentProviderDisabledError(provider);
  }
}
