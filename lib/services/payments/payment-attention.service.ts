/**
 * MONEY THAT NEEDS A PERSON — one read, for one business.
 *
 * Money must not fail silently. Every situation below already leaves a DURABLE
 * row behind (a paused accounting row, a reversal still PENDING, an anomaly in
 * the append-only audit trail, an open link on a provider that is no longer
 * offered). This service does not create a second store of truth; it gathers
 * those rows into one list a screen, a support person or an alert can read —
 * so "is there money here that needs handling?" has one answer, not five.
 *
 * Read-only. Runs inside the business's own tenant context, so every source is
 * under its FORCE-RLS policy; nothing here can see another business.
 */

import type { PaymentStore } from "./payments.types";
import { isPaymentProviderEnabled } from "./providers/provider-availability";

export type PaymentAttentionKind =
  /** A verified payment or a settled refund whose accounting is paused. */
  | "ACCOUNTING"
  /** A refund the provider never confirmed — money may have left. */
  | "REFUND_UNRESOLVED"
  /** The provider's answer about a payment could not be trusted as-is. */
  | "VERIFICATION_ANOMALY"
  /** An open payment link on a provider that no longer takes new payments. */
  | "DISABLED_PROVIDER_OPEN";

export interface PaymentAttentionItem {
  kind: PaymentAttentionKind;
  /** Machine-readable cause (an accounting reason, an audit event type, …). */
  reason: string;
  paymentRequestId: number;
  paymentTransactionId: number | null;
  since: Date;
  /** Older than the kind's patience — it should have resolved by now. */
  stale: boolean;
}

export interface PaymentAttention {
  items: PaymentAttentionItem[];
  counts: Record<PaymentAttentionKind, number>;
}

/** Anomalies whose evidence is an audit event, as long as the request is still unpaid. */
const VERIFICATION_ANOMALY_EVENTS = [
  "PAYMENT_VERIFIED_WITHOUT_AMOUNT",
  "PAYMENT_VERIFIED_WITHOUT_TRANSACTION_ID",
  "PAYMENT_PROVIDER_TRANSACTION_CONFLICT",
  "PAYMENT_PROVIDER_ANSWER_MISMATCH",
] as const;

const REFUND_STALE_MS = 24 * 60 * 60_000;
const LIMIT = 100;

export async function listPaymentAttention(
  businessId: number,
  deps: { store: PaymentStore; now?: () => Date }
): Promise<PaymentAttention> {
  const now = (deps.now ?? (() => new Date()))();
  const items: PaymentAttentionItem[] = [];

  for (const row of await deps.store.listAccountingAttention(businessId, { limit: LIMIT })) {
    items.push({
      kind: "ACCOUNTING",
      reason: row.reason,
      paymentRequestId: row.paymentRequestId,
      paymentTransactionId: row.paymentTransactionId,
      since: row.since,
      stale: false,
    });
  }

  for (const r of await deps.store.listUnresolvedReversals(businessId, {
    createdBefore: now,
    limit: LIMIT,
  })) {
    items.push({
      kind: "REFUND_UNRESOLVED",
      reason: "REFUND_NOT_CONFIRMED_BY_PROVIDER",
      paymentRequestId: r.transaction.paymentRequestId,
      paymentTransactionId: r.transaction.id,
      since: r.transaction.createdAt,
      stale: now.getTime() - r.transaction.createdAt.getTime() > REFUND_STALE_MS,
    });
  }

  const seenAnomaly = new Set<string>();
  for (const eventType of VERIFICATION_ANOMALY_EVENTS) {
    const events = await deps.store.listAuditEvents(businessId, { eventType, limit: LIMIT });
    for (const e of events) {
      if (e.paymentRequestId == null) continue;
      const key = `${eventType}:${e.paymentRequestId}`;
      if (seenAnomaly.has(key)) continue;
      seenAnomaly.add(key);
      const request = await deps.store.findPaymentRequestById(e.paymentRequestId);
      // Resolved since (the money was recorded after all): no longer attention.
      if (!request || request.businessId !== businessId || request.status === "PAID") continue;
      items.push({
        kind: "VERIFICATION_ANOMALY",
        reason: eventType,
        paymentRequestId: request.id,
        paymentTransactionId: null,
        since: e.occurredAt,
        stale: false,
      });
    }
  }

  const open = await deps.store.listPaymentRequestsByStatuses(
    businessId,
    ["PENDING", "FAILED", "CANCELLED", "EXPIRED"],
    { limit: 500 }
  );
  for (const request of open) {
    if (isPaymentProviderEnabled(request.provider)) continue;
    if (!request.paymentUrl && !request.providerRequestId) continue;
    items.push({
      kind: "DISABLED_PROVIDER_OPEN",
      reason: `PROVIDER_DISABLED:${request.provider}`,
      paymentRequestId: request.id,
      paymentTransactionId: null,
      since: request.createdAt,
      stale: false,
    });
  }

  const counts: Record<PaymentAttentionKind, number> = {
    ACCOUNTING: 0,
    REFUND_UNRESOLVED: 0,
    VERIFICATION_ANOMALY: 0,
    DISABLED_PROVIDER_OPEN: 0,
  };
  for (const item of items) counts[item.kind]++;
  return { items, counts };
}
