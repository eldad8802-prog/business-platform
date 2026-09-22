import { NotFoundError, ValidationError } from "@/lib/errors";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import {
  requeueSettlement,
  settleVerifiedPayment,
  type SettleVerifiedPaymentResult,
} from "@/lib/services/billing/settlement/payment-accounting-settlement.service";
import { buildPaymentAuditRow } from "@/lib/services/payments/payment-audit.service";
import type { Prisma } from "@prisma/client";

/**
 * The owner resolves what paused a verified payment's receipt, and Dubiz tries
 * again — through the one canonical settlement, never a second path.
 *
 * The only fact a person may supply here is WHO paid, and only for a payment
 * that arrived with no customer and no invoice (the NO_CUSTOMER pause). Every
 * other cause (billing profile, retries exhausted) is fixed where it lives;
 * this simply returns the settlement to the queue and runs it.
 *
 * Exactly once regardless: the settlement row lock and the UNIQUE receipt link
 * mean a double-click, a concurrent recovery run and this call together still
 * produce one receipt.
 */
export async function resolveAndRetrySettlement(input: {
  businessId: number;
  paymentTransactionId: number;
  actorUserId: number;
  customerId: number | null;
}): Promise<SettleVerifiedPaymentResult> {
  const { businessId, paymentTransactionId } = input;

  const state = await billingTenantTx(businessId, async (tx) => {
    const settlement = await tx.paymentAccountingSettlement.findFirst({
      where: { businessId, paymentTransactionId },
      select: {
        status: true,
        attentionReason: true,
        paymentTransaction: {
          select: {
            paymentRequest: {
              select: { id: true, businessId: true, customerId: true, billingDocumentId: true },
            },
          },
        },
      },
    });
    if (!settlement) throw new NotFoundError("Payment settlement not found");
    const request = settlement.paymentTransaction.paymentRequest;
    if (request.businessId !== businessId) throw new NotFoundError("Payment settlement not found");

    if (input.customerId !== null) {
      if (settlement.status !== "REQUIRES_ATTENTION" || settlement.attentionReason !== "NO_CUSTOMER") {
        throw new ValidationError("הלקוח כבר ידוע לתשלום הזה");
      }
      if (request.customerId !== null || request.billingDocumentId !== null) {
        throw new ValidationError("הלקוח כבר ידוע לתשלום הזה");
      }
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundError("Customer not found");
      await tx.paymentRequest.update({
        where: { id: request.id },
        data: { customerId: customer.id },
      });
      const row = buildPaymentAuditRow({
        businessId,
        paymentRequestId: request.id,
        actorUserId: input.actorUserId,
        eventType: "PAYMENT_ACCOUNTING_CUSTOMER_NAMED",
        source: "USER",
        summary: `Owner named the customer of verified payment ${paymentTransactionId}`,
        metadata: { paymentTransactionId, customerId: customer.id },
      });
      await tx.paymentAuditEvent.create({
        data: { ...row, metadata: row.metadata as Prisma.InputJsonValue },
      });
    }
    return settlement.status;
  });

  if (state === "REQUIRES_ATTENTION") {
    await requeueSettlement({ businessId, paymentTransactionId });
  }
  return settleVerifiedPayment({ businessId, paymentTransactionId });
}
