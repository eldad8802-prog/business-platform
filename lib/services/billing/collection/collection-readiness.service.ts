import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import {
  AmbiguousPaymentProviderError,
  selectPaymentProvider,
} from "@/lib/services/payments/payment-request.service";
import type { PaymentProvider, PaymentStore } from "@/lib/services/payments/payments.types";
import type { PaymentProviderAdapter } from "@/lib/services/payments/providers/payment-provider.types";
import { resolvePaymentProvider } from "@/lib/services/payments/providers/provider-registry";
import {
  DEFAULT_OFFERABLE_CURRENCIES,
  offerableCurrencies,
} from "@/lib/services/payments/payment-currency-offer";
import type { CurrencyCode } from "@/lib/money/currency";

/**
 * Can this business collect right now — and if not, exactly what is missing?
 *
 * Asked BEFORE a request is created, so the owner is sent to fix the gap
 * instead of producing a broken link (stage-aware rule: show what is missing
 * before failure). The provider decision is the same deterministic one
 * createPaymentRequest applies; the owner never picks a provider while
 * collecting — that lives in Settings.
 *
 *   NO_PAYMENT_PROVIDER          no active, enabled connection   → /settings/connections
 *   PAYMENT_PROVIDER_AMBIGUOUS   several active connections      → /settings/connections
 *   BILLING_IDENTITY_INCOMPLETE  receipts could not be issued    → /business
 */
export type CollectionBlocker =
  | "NO_PAYMENT_PROVIDER"
  | "PAYMENT_PROVIDER_AMBIGUOUS"
  | "BILLING_IDENTITY_INCOMPLETE";

export type CollectionReadiness = {
  ready: boolean;
  blockers: CollectionBlocker[];
  /**
   * Currencies a standalone payment request may be raised in right now: the
   * Dubiz set (ILS / USD / EUR) narrowed by the provider createPaymentRequest
   * would select. ILS first. With no resolvable provider: ILS alone.
   */
  offerableCurrencies: CurrencyCode[];
};

/** The provider-dependent part of readiness — pure apart from the store read. */
export async function loadCollectionProviderReadiness(
  businessId: number,
  store: Pick<PaymentStore, "listConnections">,
  resolveProvider: (provider: PaymentProvider) => Pick<PaymentProviderAdapter, "supportedCurrencies"> = resolvePaymentProvider
): Promise<{ blocker: CollectionBlocker | null; offerableCurrencies: CurrencyCode[] }> {
  let provider: PaymentProvider;
  try {
    provider = await selectPaymentProvider({ businessId, requested: null }, store);
  } catch (error) {
    return {
      blocker:
        error instanceof AmbiguousPaymentProviderError
          ? "PAYMENT_PROVIDER_AMBIGUOUS"
          : "NO_PAYMENT_PROVIDER",
      offerableCurrencies: [...DEFAULT_OFFERABLE_CURRENCIES],
    };
  }
  return {
    blocker: null,
    offerableCurrencies: offerableCurrencies(resolveProvider(provider).supportedCurrencies),
  };
}

export async function loadCollectionReadiness(
  businessId: number,
  store: Pick<PaymentStore, "listConnections">
): Promise<CollectionReadiness> {
  const blockers: CollectionBlocker[] = [];
  const provider = await loadCollectionProviderReadiness(businessId, store);
  if (provider.blocker) blockers.push(provider.blocker);
  const profile = await billingTenantTx(businessId, (tx) =>
    tx.businessProfile.findUnique({
      where: { businessId },
      select: {
        billingLegalName: true,
        billingBusinessKind: true,
        billingTaxId: true,
        billingPhone: true,
        billingEmail: true,
        billingAddress: true,
      },
    })
  );
  try {
    assertBillingIdentityReadyForTaxInvoice(profile);
  } catch {
    blockers.push("BILLING_IDENTITY_INCOMPLETE");
  }
  return { ready: blockers.length === 0, blockers, offerableCurrencies: provider.offerableCurrencies };
}
