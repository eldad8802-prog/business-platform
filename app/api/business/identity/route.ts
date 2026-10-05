import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { getBusinessIdentity } from "@/lib/services/identity/business-identity";
import { createIdentityStatement } from "@/lib/services/identity/identity-statement.service";
import { identityErrorResponse } from "@/lib/services/identity/identity-http";

/** P2 — the business identity read model: facts, owner statements, derived signals. */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const identity = await tenantTx(user.businessId, (tx) => getBusinessIdentity(user.businessId, tx));
    return NextResponse.json({ identity });
  } catch (error) {
    return identityErrorResponse(error, "GET /api/business/identity");
  }
}

/** P2 — the owner states one identity value. The tenant and the author come from the session only. */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json()) as {
      dimension?: unknown;
      code?: unknown;
      text?: unknown;
      channel?: unknown;
      replacesStatementId?: unknown;
    };
    const replaces = body.replacesStatementId == null ? null : Number(body.replacesStatementId);
    if (replaces !== null && (!Number.isInteger(replaces) || replaces <= 0)) {
      return NextResponse.json({ error: "Invalid replacesStatementId" }, { status: 400 });
    }
    const statement = await tenantTx(user.businessId, (tx) =>
      createIdentityStatement(
        {
          businessId: user.businessId,
          userId: user.id,
          dimension: body.dimension,
          code: body.code,
          text: body.text,
          channel: body.channel,
          source: "OWNER_INPUT",
          sourceRef: "settings",
          replacesStatementId: replaces,
        },
        tx,
      ),
    );
    return NextResponse.json({ statement });
  } catch (error) {
    return identityErrorResponse(error, "POST /api/business/identity");
  }
}
