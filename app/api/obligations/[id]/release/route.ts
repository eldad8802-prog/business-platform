import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { releaseObligation } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { toObligationApi } from "@/lib/services/obligations/obligation-api.serializer";

export const runtime = "nodejs";

function parseObligationId(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid obligation id");
  }
  return num;
}

/** Release — the underlying commitment ceased to exist. Idempotent. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const obligationId = parseObligationId(id);

    const updated = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          releaseObligation(
            user.businessId,
            obligationId,
            obligationServiceDeps({ tx })
          )
        )
    );

    return NextResponse.json(toObligationApi(updated), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
