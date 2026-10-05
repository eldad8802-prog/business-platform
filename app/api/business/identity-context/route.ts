import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { getBusinessIdentityContext } from "@/lib/services/identity/business-identity-context";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

/**
 * P3-A — the canonical BusinessIdentityContext for the signed-in owner's business: identity, public
 * facts, trust claims, conversion paths, readiness. The tenant comes from the session only.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const context = await tenantTx(user.businessId, (tx) => getBusinessIdentityContext(user.businessId, tx));
    return NextResponse.json({ context });
  } catch (error) {
    return trustErrorResponse(error, "GET /api/business/identity-context");
  }
}
