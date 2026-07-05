/**
 * Provider registry — resolves a `PaymentProvider` to its adapter.
 *
 * Services depend on a `(provider) => adapter` resolver, never on a concrete
 * provider. The registry is the single place that wires provider names to
 * implementations; adding a provider means registering it here.
 */

import type { PaymentProvider } from "../payments.types";
import type { PaymentProviderAdapter } from "./payment-provider.types";
import type { ProviderDescriptor } from "./provider-descriptor.types";
import { tranzilaProvider, tranzilaDescriptor } from "./tranzila/tranzila.provider";
import { cardComProvider, cardComDescriptor } from "./cardcom/cardcom.provider";
import { payPalProvider, payPalDescriptor } from "./paypal/paypal.provider";

const REGISTRY: Record<PaymentProvider, PaymentProviderAdapter> = {
  TRANZILA: tranzilaProvider,
  CARDCOM: cardComProvider,
  PAYPAL: payPalProvider,
};

/**
 * Declarative descriptors, keyed identically to REGISTRY. Adding a provider =
 * add its adapter + descriptor here (+ enum value). The generic connection
 * route, catalog endpoint, and data-driven UI all read from these — no new
 * route or UI per provider.
 */
const DESCRIPTORS: Record<PaymentProvider, ProviderDescriptor> = {
  TRANZILA: tranzilaDescriptor,
  CARDCOM: cardComDescriptor,
  PAYPAL: payPalDescriptor,
};

export class UnknownPaymentProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown payment provider: ${provider}`);
    this.name = "UnknownPaymentProviderError";
  }
}

export function resolvePaymentProvider(
  provider: PaymentProvider
): PaymentProviderAdapter {
  const adapter = REGISTRY[provider];
  if (!adapter) {
    throw new UnknownPaymentProviderError(provider);
  }
  return adapter;
}

export function isSupportedProvider(value: string): value is PaymentProvider {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/** Descriptor for one provider, or null if unknown. */
export function getProviderDescriptor(
  provider: string
): ProviderDescriptor | null {
  if (!isSupportedProvider(provider)) return null;
  return DESCRIPTORS[provider];
}

/** All provider descriptors (catalog source; metadata only, no secrets). */
export function listProviderDescriptors(): ProviderDescriptor[] {
  return Object.values(DESCRIPTORS);
}
