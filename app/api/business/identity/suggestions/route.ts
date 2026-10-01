import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { adoptIdentitySuggestion } from "@/lib/services/identity/business-identity";
import { identityErrorResponse } from "@/lib/services/identity/identity-http";

/**
 * P2 — the owner adopts one derived suggestion. The server recomputes the signal from this
 * business's own evidence; the client only names which suggestion it accepted.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as { signalKey?: unknown; dimension?: unknown; code?: unknown };
    const statement = await tenantTx(user.businessId, (tx) =>
      adoptIdentitySuggestion(
        { businessId: user.businessId, userId: user.id, signalKey: body.signalKey, dimension: body.dimension, code: body.code },
        tx,
      ),
    );
    return NextResponse.json({ statement });
  } catch (error) {
    return identityErrorResponse(error, "POST /api/business/identity/suggestions");
  }
}
