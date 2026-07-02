import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import {
  connectProviderFromDescriptor,
  listPaymentConnections,
} from "@/lib/services/payments/payment-connection.service";
import { paymentConnectionDeps } from "@/lib/services/payments/payments.deps";

export const runtime = "nodejs";

/** List the business's payment connections. Never returns credentials. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CONNECT_PROVIDER);

    const connections = await listPaymentConnections(
      actor.businessId,
      paymentConnectionDeps()
    );

    return NextResponse.json({ connections }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Generic, descriptor-driven connect: `{ provider, <merchantIdField>, ...creds }`.
 * Validation + credential shape come from the provider's descriptor — no
 * provider-specific code here. Secrets are write-only; the response carries only
 * the public connection shape.
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

    const connection = await connectProviderFromDescriptor(
      {
        businessId: actor.businessId,
        actorUserId: actor.userId,
        provider: typeof body.provider === "string" ? body.provider : "",
        fields: body,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      },
      paymentConnectionDeps()
    );

    return NextResponse.json({ connection }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
