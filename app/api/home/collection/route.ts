import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { loadHomeCollection } from "@/lib/services/home/home-collection.service";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/home/collection?period=today|yesterday|week
 *
 * Read-only. Money collected through Dubiz over the period and over the period
 * before it, cut at the same point in both, plus the month context — one answer
 * for the whole collection area of Home.
 *
 * The business is the session's business: `businessId` is never taken from the
 * request, and the read runs inside the tenant context so RLS applies.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const { searchParams } = new URL(req.url);

    const model = await runWithTenantContext({ businessId: actor.businessId }, () =>
      loadHomeCollection(actor.businessId, { period: searchParams.get("period") })
    );
    return NextResponse.json(model, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
