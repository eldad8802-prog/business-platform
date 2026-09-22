import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as prep from "@/lib/services/payables/payables-preparation.service";

export const runtime = "nodejs";

/**
 * Cancel a prepared payment that has not been paid.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const recordId = parseId(id, "id");
    const body = await readJsonBody(req);

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      prep.cancelPreparation({ businessId: user.businessId, actorUserId: user.id, preparationId: recordId, reason: body.reason }),
    );
    return NextResponse.json({ preparation: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}
