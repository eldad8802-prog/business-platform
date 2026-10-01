import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { decideFactAuthority } from "@/lib/services/identity/identity-fact-authority.service";
import { identityErrorResponse } from "@/lib/services/identity/identity-http";

/**
 * P2 — the owner confirms an identity fact, or approves / withdraws its public use. The value is
 * never sent: the server reads it from its canonical column and binds the decision to it.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { fact?: unknown; action?: unknown };
    const authority = await tenantTx(user.businessId, (tx) =>
      decideFactAuthority({ businessId: user.businessId, userId: user.id, fact: body.fact, action: body.action }, tx),
    );
    return NextResponse.json({ authority });
  } catch (error) {
    return identityErrorResponse(error, "POST /api/business/identity/facts");
  }
}
