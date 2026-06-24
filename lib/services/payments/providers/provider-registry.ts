/**
 * Provider registry — resolves a `PaymentProvider` to its adapter.
 *
 * Services depend on a `(provider) => adapter` resolver, never on a concrete
 * provider. The registry is the single place that wires provider names to
 * implementations; adding a provider means registering it here.
 */

import type { PaymentProvider } from "../payments.types";
import type { PaymentProviderAdapter } from "./payment-provider.types";
import { tranzilaProvider } from "./tranzila/tranzila.provider";
import { cardComProvider } from "./cardcom/cardcom.provider";

const REGISTRY: Record<PaymentProvider, PaymentProviderAdapter> = {
  TRANZILA: tranzilaProvider,
  // CardCom is a registered identity only (I1). The stub fails clearly if
  // invoked — no integration is implemented yet.
  CARDCOM: cardComProvider,
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
