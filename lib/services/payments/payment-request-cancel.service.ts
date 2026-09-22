import { NotFoundError, ValidationError } from "@/lib/errors";
import { recordPaymentAuditEvent } from "./payment-audit.service";
import type { PaymentRequestRecord, PaymentStore } from "./payments.types";

/**
 * The owner cancels a collection request — the ASK, never the money.
 *
 * Only an open (PENDING) request can be cancelled, and never one that already
 * carries verified money: a payment that arrived is a fact, and cancelling
 * the request would not make it untrue. If the customer pays through the link
 * after it was cancelled, the provider-verified payment is still recorded and
 * settled like any other — Dubiz does not refuse money that arrived; it simply
 * stops asking for it.
 */
export async function cancelPaymentRequest(
  input: { businessId: number; requestId: number; actorUserId: number },
  deps: { store: PaymentStore; now?: () => Date }
): Promise<PaymentRequestRecord> {
  const now = deps.now ?? (() => new Date());
  const request = await deps.store.findPaymentRequestById(input.requestId);
  if (!request || request.businessId !== input.businessId) {
    throw new NotFoundError("Payment request not found");
  }
  if (request.status !== "PENDING") {
    throw new ValidationError("רק בקשת תשלום פתוחה אפשר לבטל");
  }
  const transactions = await deps.store.listTransactionsByRequest(request.id);
  if (transactions.some((t) => t.status === "PAID" && Number(t.amount) > 0)) {
    throw new ValidationError("התשלום כבר התקבל — אי אפשר לבטל בקשה ששולמה");
  }
  const updated = await deps.store.updatePaymentRequest(request.id, { status: "CANCELLED" });
  await recordPaymentAuditEvent(deps.store, {
    businessId: input.businessId,
    paymentRequestId: request.id,
    actorUserId: input.actorUserId,
    eventType: "PAYMENT_REQUEST_CANCELLED",
    source: "USER",
    summary: `Payment request ${request.id} cancelled by the owner`,
    metadata: { previousStatus: request.status },
    occurredAt: now(),
  });
  return updated;
}
