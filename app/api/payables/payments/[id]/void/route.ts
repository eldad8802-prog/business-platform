import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { voidPayment } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — void a payment that never really happened.
 *
 * Nothing is deleted. The payment's status flips, and because an allocation is
 * active only while its payment is RECORDED, every amount it applied stops
 * counting at once — without rewriting a single allocation row, which is what
 * makes this safe: updating N rows could half-succeed.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const paymentId = parseId(id, "payment id");
    const body = await readJsonBody(req);

    const payment = await runWithTenantContext({ businessId: user.businessId }, () =>
      voidPayment({
        businessId: user.businessId,
        paymentId,
        actorUserId: user.id,
        reason: optionalString(body, "reason"),
      }),
    );

    return NextResponse.json({ payment });
  } catch (error) {
    return handlePayablesError(error);
  }
}
