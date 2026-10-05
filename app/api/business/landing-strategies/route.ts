import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { getLandingStrategySet } from "@/lib/services/landing/landing-strategy.service";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

/**
 * P3-B — the landing strategy set (1–3 genuinely different, deterministic strategy proposals) for the
 * signed-in owner's business. The tenant comes from the session only; no business id is accepted from
 * the client. Read-only: nothing is stored, nothing is published. Not a public route.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const strategySet = await tenantTx(user.businessId, (tx) => getLandingStrategySet(user.businessId, tx));
    return NextResponse.json({ strategySet }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return trustErrorResponse(error, "GET /api/business/landing-strategies");
  }
}
