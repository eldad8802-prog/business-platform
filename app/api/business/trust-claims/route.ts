import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { confirmTrustClaim } from "@/lib/services/trust/trust-claim.service";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

/**
 * P3-A — the owner confirms a trust claim from structured parameters (never free wording). The claim
 * is created INTERNAL: public use is a separate action. Tenant and author come from the session only.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { kind?: unknown; params?: unknown };
    const claim = await tenantTx(user.businessId, (tx) =>
      confirmTrustClaim({ businessId: user.businessId, userId: user.id, kind: body.kind, params: body.params }, tx),
    );
    return NextResponse.json({ claim });
  } catch (error) {
    return trustErrorResponse(error, "POST /api/business/trust-claims");
  }
}
