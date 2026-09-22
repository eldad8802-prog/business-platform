import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { cancelPaymentRequest } from "@/lib/services/payments/payment-request-cancel.service";
import { createPaymentPrismaStore } from "@/lib/services/payments/payment-store.prisma";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";

/**
 * The owner stops asking for this payment. Open requests only; a request that
 * already carries verified money cannot be cancelled. The body carries nothing:
 * the business comes from the authenticated actor.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CREATE_CHARGE);
    const { id } = await context.params;
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new ValidationError("Invalid payment request id");
    }
    const updated = await runWithTenantContext({ businessId: actor.businessId }, () =>
      cancelPaymentRequest(
        { businessId: actor.businessId, requestId, actorUserId: actor.userId },
        { store: createPaymentPrismaStore() }
      )
    );
    return NextResponse.json({ id: updated.id, status: updated.status }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
