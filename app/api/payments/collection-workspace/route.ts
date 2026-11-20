import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { getCollectionWorkspace } from "@/lib/services/payments/collection-workspace.service";
import { toCollectionWorkspaceApi } from "@/lib/services/payments/payment-api.serializer";
import { paymentRequestDeps } from "@/lib/services/payments/payments.deps";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";

/**
 * Collection Workspace read model — the single source of truth for the main
 * collection screen: summary · attention · active · history, all derived from
 * objective data (business-scoped). Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);

    const result = await await runWithTenantContext(
      { businessId: actor.businessId },
      () =>
        getCollectionWorkspace(paymentRequestDeps().store, {
          businessId: actor.businessId,
          now: new Date(),
        })
    );

    return NextResponse.json(toCollectionWorkspaceApi(result), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
