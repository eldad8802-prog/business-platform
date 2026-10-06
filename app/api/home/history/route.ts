import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { loadHomeHistory } from "@/lib/services/home/home-history.service";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/home/history
 *
 * Read-only. One boolean per Home card — "has this business ever had a real
 * event of this kind?" — plus the WhatsApp connection state the lead card may
 * act on. The Home uses it to tell a brand-new card from one that is simply
 * at 0 today; it never infers "no history" from a value being 0.
 *
 * The business is the session's business — never taken from the request — and
 * the read runs in the tenant context so RLS applies on top of the explicit
 * businessId in every predicate.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const history = await runWithTenantContext({ businessId: user.businessId }, () =>
      loadHomeHistory(user.businessId)
    );
    return NextResponse.json(history, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
