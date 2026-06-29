import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { listPaymentConnections } from "@/lib/services/payments/payment-connection.service";
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
