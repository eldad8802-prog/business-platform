import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { loadInvoiceEconomicStateTx } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The invoice's collection state for the billing screen: שולם / זוכה / נותר,
 * from the one shared economic rule, plus the latest request against it.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const { id } = await context.params;
    const invoiceId = Number(id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new ValidationError("Invalid invoice id");
    const businessId = actor.businessId;
    const result = await billingTenantTx(businessId, async (tx) => {
      const inv = await tx.billingDocument.findFirst({
        where: { id: invoiceId, businessId, documentType: "TAX_INVOICE", status: "ISSUED" },
        select: { id: true, totalAmount: true, currency: true, customerId: true },
      });
      if (!inv) throw new NotFoundError("Invoice not found");
      const state = await loadInvoiceEconomicStateTx(tx, {
        businessId,
        invoiceDocumentId: inv.id,
        totalAmount: inv.totalAmount,
      });
      const latest = await tx.paymentRequest.findFirst({
        where: { businessId, billingDocumentId: inv.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, amount: true, createdAt: true },
      });
      return {
        invoiceId: inv.id,
        customerId: inv.customerId,
        currency: inv.currency,
        total: inv.totalAmount.toFixed(2),
        paid: state.issuedAllocated.toFixed(2),
        credited: state.issuedCredited.toFixed(2),
        remaining: state.economicRemaining.toFixed(2),
        latestRequest: latest
          ? { id: latest.id, status: latest.status, amount: latest.amount.toFixed(2), createdAt: latest.createdAt.toISOString() }
          : null,
      };
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
