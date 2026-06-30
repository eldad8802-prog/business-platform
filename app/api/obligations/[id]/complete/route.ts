import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { completeObligation } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { toObligationApi } from "@/lib/services/obligations/obligation-api.serializer";

export const runtime = "nodejs";

function parseObligationId(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid obligation id");
  }
  return num;
}

/**
 * Complete — owner-asserted closure (Met). Idempotent. For a recurring
 * obligation, the next instance is recognized and returned.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const obligationId = parseObligationId(id);

    const result = await completeObligation(
      user.businessId,
      obligationId,
      obligationServiceDeps()
    );

    return NextResponse.json(
      {
        obligation: toObligationApi(result.obligation),
        nextInstance: result.nextInstance
          ? toObligationApi(result.nextInstance)
          : null,
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
