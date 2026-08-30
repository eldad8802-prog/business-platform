import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { connectProviderFromDescriptor } from "@/lib/services/payments/payment-connection.service";
import { paymentConnectionDeps } from "@/lib/services/payments/payments.deps";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";

/**
 * Backward-compatible Tranzila wrapper. Preserves the legacy body
 * `{ merchantId, credential }` but routes through the generic, descriptor-driven
 * connect so the stored credential shape matches every other provider. Prefer
 * the generic `POST /api/payments/connections` for new callers.
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

    const connection = await await runWithTenantContext(
      { businessId: actor.businessId },
      () =>
        connectProviderFromDescriptor(
          {
            businessId: actor.businessId,
            actorUserId: actor.userId,
            provider: "TRANZILA",
            fields: { merchantId: body.merchantId, secret: body.credential },
            isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
          },
          paymentConnectionDeps()
        )
    );

    return NextResponse.json({ connection }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
