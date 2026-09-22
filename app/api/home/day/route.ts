import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { FutureDayError, loadHomeDay } from "@/lib/services/home/home-day.service";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/home/day?date=YYYY-MM-DD&scope=full|day
 *
 * Read-only. Money collected through Dubiz on one Israeli calendar day, plus
 * (on `scope=full`) the month context and today's activity counts, so the Home
 * screen asks one question instead of four.
 *
 * The business is the session's business — `businessId` is never taken from the
 * request, and the read runs inside the tenant context so RLS applies.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const { searchParams } = new URL(req.url);
    const scope = searchParams.get("scope") === "day" ? "day" : "full";

    const model = await runWithTenantContext({ businessId: actor.businessId }, () =>
      loadHomeDay(actor.businessId, { date: searchParams.get("date"), scope })
    );
    return NextResponse.json(model, { status: 200 });
  } catch (error) {
    if (error instanceof FutureDayError) {
      return NextResponse.json({ error: "future_date" }, { status: 400 });
    }
    return handleError(error);
  }
}
