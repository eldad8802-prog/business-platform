import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { withHomeCollectionDiagnostics } from "@/lib/services/home/home-collection-diagnostics";
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
  // Observability only: the same work, the same error to the same handleError.
  // A 5xx additionally leaves one safe `home_collection_failed` line.
  return withHomeCollectionDiagnostics(req, async () => {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const { searchParams } = new URL(req.url);

    const model = await runWithTenantContext({ businessId: actor.businessId }, () =>
      loadHomeCollection(actor.businessId, { period: searchParams.get("period") })
    );
    return NextResponse.json(model, { status: 200 });
  });
}
