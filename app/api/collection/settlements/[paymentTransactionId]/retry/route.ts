import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { resolveAndRetrySettlement } from "@/lib/services/billing/settlement/settlement-resolution.service";

export const runtime = "nodejs";

/**
 * After the owner fixes what paused a verified payment's receipt (named the
 * customer, completed the billing profile), run the SAME canonical settlement
 * again. Body: `{ customerId? }` — only to name the customer of a payment that
 * arrived without one. Nothing else is accepted from the caller.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ paymentTransactionId: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CREATE_CHARGE);
    const { paymentTransactionId } = await context.params;
    const ptx = Number(paymentTransactionId);
    if (!Number.isInteger(ptx) || ptx <= 0) throw new ValidationError("Invalid payment id");
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const raw = (body as { customerId?: unknown }).customerId;
    const customerId = raw === undefined || raw === null ? null : Number(raw);
    if (customerId !== null && (!Number.isInteger(customerId) || customerId <= 0)) {
      throw new ValidationError("Invalid customer id");
    }
    const result = await resolveAndRetrySettlement({
      businessId: actor.businessId,
      paymentTransactionId: ptx,
      actorUserId: actor.userId,
      customerId,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
