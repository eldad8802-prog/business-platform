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
 *
 * M1: the request then follows the money — a verified payment moves a
 * cancelled request to PAID (the cancellation stays in the audit trail), so the
 * owner sees what is true and the payment is handled like any other. Cancelling
 * is local: it never voids anything at the provider.
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
  // M1 — conditional at the database: the request is cancelled only if it is
  // STILL open at the moment of the write. A verified payment that landed
  // between the checks above and this write has already moved it to PAID, and
  // an unconditional write would have painted real money CANCELLED.
  const updated = await deps.store.transitionPaymentRequestStatus(request.id, {
    from: ["PENDING"],
    to: "CANCELLED",
  });
  if (!updated) {
    throw new ValidationError("מצב הבקשה השתנה — ייתכן שהתשלום התקבל. רעננו את המסך.");
  }
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
