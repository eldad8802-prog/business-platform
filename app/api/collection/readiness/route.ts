import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { loadCollectionReadiness } from "@/lib/services/billing/collection/collection-readiness.service";
import { createPaymentPrismaStore } from "@/lib/services/payments/payment-store.prisma";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What is missing before this business can collect — asked before creating a request. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CREATE_CHARGE);
    const readiness = await runWithTenantContext({ businessId: actor.businessId }, () =>
      loadCollectionReadiness(actor.businessId, createPaymentPrismaStore())
    );
    return NextResponse.json(readiness, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
