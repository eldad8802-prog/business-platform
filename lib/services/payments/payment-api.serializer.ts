/**
 * API serializers for payment records. Keep route output shapes in one place.
 */

import type {
  PaymentAuditEventRecord,
  PaymentRequestRecord,
  PaymentTransactionRecord,
} from "./payments.types";

export interface PaymentRequestApi {
  id: number;
  status: string;
  amount: string;
  currency: string;
  description: string | null;
  paymentUrl: string | null;
  provider: string;
  createdAt: string;
}

export interface PaymentRequestListItemApi extends PaymentRequestApi {
  customerId: number | null;
  billingDocumentId: number | null;
  paidAt: string | null;
}

export function toPaymentRequestApi(
  record: PaymentRequestRecord
): PaymentRequestApi {
  return {
    id: record.id,
    status: record.status,
    amount: record.amount,
    currency: record.currency,
    description: record.description,
    paymentUrl: record.paymentUrl,
    provider: record.provider,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toPaymentRequestListItemApi(
  record: PaymentRequestRecord
): PaymentRequestListItemApi {
  return {
    ...toPaymentRequestApi(record),
    customerId: record.customerId,
    billingDocumentId: record.billingDocumentId,
    paidAt: record.paidAt ? record.paidAt.toISOString() : null,
  };
}

// --- Ledger (M4): a payment request's settlement records + audit ----------

export interface PaymentTransactionApi {
  id: number;
  paymentRequestId: number;
  provider: string;
  providerTransactionId: string | null;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
}

/** Serialize a settlement record. Deliberately omits `rawPayload` — the raw
 * provider body is internal and never exposed through the API. */
export function toPaymentTransactionApi(
  record: PaymentTransactionRecord
): PaymentTransactionApi {
  return {
    id: record.id,
    paymentRequestId: record.paymentRequestId,
    provider: record.provider,
    providerTransactionId: record.providerTransactionId,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface PaymentAuditEventApi {
  id: number;
  eventType: string;
  source: string;
  summary: string;
  actorUserId: number | null;
  occurredAt: string;
}

/** Serialize an audit event for the ledger timeline. Omits the integrity hash
 * and raw metadata — only the human-readable, non-sensitive fields. */
export function toPaymentAuditEventApi(
  record: PaymentAuditEventRecord
): PaymentAuditEventApi {
  return {
    id: record.id,
    eventType: record.eventType,
    source: record.source,
    summary: record.summary,
    actorUserId: record.actorUserId,
    occurredAt: record.occurredAt.toISOString(),
  };
}

export interface PaymentRequestDetailApi {
  request: PaymentRequestListItemApi;
  transactions: PaymentTransactionApi[];
  audit: PaymentAuditEventApi[];
}

export function toPaymentRequestDetailApi(detail: {
  request: PaymentRequestRecord;
  transactions: PaymentTransactionRecord[];
  audit: PaymentAuditEventRecord[];
}): PaymentRequestDetailApi {
  return {
    request: toPaymentRequestListItemApi(detail.request),
    transactions: detail.transactions.map(toPaymentTransactionApi),
    audit: detail.audit.map(toPaymentAuditEventApi),
  };
}
