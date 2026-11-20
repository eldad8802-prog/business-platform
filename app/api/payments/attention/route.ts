import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { listPaymentAttention } from "@/lib/services/payments/payment-attention.service";
import { paymentRefundDeps } from "@/lib/services/payments/payments.deps";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Money that needs a person, for the caller's own business: paused accounting,
 * refunds a provider never confirmed, verification anomalies, and open links on
 * a provider that no longer takes new payments. Read-only; ids and reasons only,
 * no provider payloads.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const attention = await runWithTenantContext({ businessId: actor.businessId }, () =>
      listPaymentAttention(actor.businessId, { store: paymentRefundDeps().store })
    );
    return NextResponse.json(attention, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
