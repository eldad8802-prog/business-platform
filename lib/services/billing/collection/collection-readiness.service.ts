import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import {
  AmbiguousPaymentProviderError,
  selectPaymentProvider,
} from "@/lib/services/payments/payment-request.service";
import type { PaymentStore } from "@/lib/services/payments/payments.types";

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
};

export async function loadCollectionReadiness(
  businessId: number,
  store: Pick<PaymentStore, "listConnections">
): Promise<CollectionReadiness> {
  const blockers: CollectionBlocker[] = [];
  try {
    await selectPaymentProvider({ businessId, requested: null }, store);
  } catch (error) {
    blockers.push(
      error instanceof AmbiguousPaymentProviderError
        ? "PAYMENT_PROVIDER_AMBIGUOUS"
        : "NO_PAYMENT_PROVIDER"
    );
  }
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
  return { ready: blockers.length === 0, blockers };
}
