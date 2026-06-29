/**
 * Payments ledger (M4) — read-only.
 *
 * Stage 2 makes PaymentTransaction readable inside the context of its
 * PaymentRequest, and ties the request to its M7 audit timeline. The unit is
 * the PaymentRequest: one request -> its settlement records -> its audit trail.
 *
 * Strictly business-scoped: a request that is not found, or belongs to another
 * business, is reported as not-found — a caller can never learn that another
 * business's request id exists. No mutation, no provider calls.
 */

import { NotFoundError, ValidationError } from "@/lib/errors";
import { getPaymentAuditTimeline } from "./payment-audit.service";
import type {
  PaymentAuditEventRecord,
  PaymentRequestRecord,
  PaymentStore,
  PaymentTransactionRecord,
} from "./payments.types";

export interface PaymentRequestDetail {
  request: PaymentRequestRecord;
  transactions: PaymentTransactionRecord[];
  audit: PaymentAuditEventRecord[];
}

/** The store surface the ledger needs — read-only. */
export type PaymentLedgerStore = Pick<
  PaymentStore,
  "findPaymentRequestById" | "listTransactionsByRequest" | "listAuditEvents"
>;

export interface GetPaymentRequestDetailInput {
  /** From the authenticated actor — never from request input. */
  businessId: number;
  requestId: number;
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

export async function getPaymentRequestDetail(
  store: PaymentLedgerStore,
  input: GetPaymentRequestDetailInput
): Promise<PaymentRequestDetail> {
  assertPositiveInt(input.businessId, "businessId");
  assertPositiveInt(input.requestId, "requestId");

  const request = await store.findPaymentRequestById(input.requestId);
  // Ownership gate: not found OR owned by another business => not-found. We do
  // NOT distinguish the two, so cross-business ids never leak.
  if (!request || request.businessId !== input.businessId) {
    throw new NotFoundError("Payment request not found");
  }

  const [transactions, audit] = await Promise.all([
    store.listTransactionsByRequest(request.id),
    getPaymentAuditTimeline(store, {
      businessId: input.businessId,
      paymentRequestId: request.id,
    }),
  ]);

  return { request, transactions, audit };
}
