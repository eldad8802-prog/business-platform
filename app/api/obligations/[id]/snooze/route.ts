import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { snoozeObligation } from "@/lib/services/obligations/obligation.service";
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

/** Postpone ("not now") — suppress from attention until followUpAt (future). */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const obligationId = parseObligationId(id);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    if (typeof body.followUpAt !== "string" || body.followUpAt === "") {
      throw new ValidationError("followUpAt is required (ISO date string)");
    }
    const followUpAt = new Date(body.followUpAt);
    if (Number.isNaN(followUpAt.getTime())) {
      throw new ValidationError("followUpAt must be a valid date");
    }

    const updated = await snoozeObligation(
      user.businessId,
      obligationId,
      followUpAt,
      obligationServiceDeps()
    );

    return NextResponse.json(toObligationApi(updated), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
