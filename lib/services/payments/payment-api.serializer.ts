/**
 * API serializers for payment records. Keep route output shapes in one place.
 */

import type { PaymentRequestRecord } from "./payments.types";

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
