import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { connectPaymentProvider } from "@/lib/services/payments/payment-connection.service";
import { paymentConnectionDeps } from "@/lib/services/payments/payments.deps";

export const runtime = "nodejs";

/**
 * Connect (or update) the business's Tranzila connection. The credential is
 * encrypted at rest and never returned — the response carries only the public
 * connection shape.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CONNECT_PROVIDER);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    if (typeof body.merchantId !== "string" || !body.merchantId.trim()) {
      throw new ValidationError("merchantId is required");
    }
    if (typeof body.credential !== "string" || !body.credential) {
      throw new ValidationError("credential is required");
    }

    const connection = await connectPaymentProvider(
      {
        businessId: actor.businessId,
        actorUserId: actor.userId,
        provider: "TRANZILA",
        merchantId: body.merchantId,
        credential: body.credential,
        isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      },
      paymentConnectionDeps()
    );

    return NextResponse.json({ connection }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
