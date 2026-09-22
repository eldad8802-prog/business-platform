import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { loadCustomerFinancialThread } from "@/lib/services/billing/collection/customer-financial-thread.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A customer's chronological financial thread. Another tenant's customer is not-found. */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ customerId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const { customerId } = await context.params;
    const id = Number(customerId);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid customer id");
    const thread = await loadCustomerFinancialThread(actor.businessId, id);
    return NextResponse.json(thread, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
