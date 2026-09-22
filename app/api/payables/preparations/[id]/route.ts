import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
} from "@/lib/services/payables/payables-http";
import * as prep from "@/lib/services/payables/payables-preparation.service";

export const runtime = "nodejs";

/**
 * One prepared payment.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const recordId = parseId(id, "id");

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      prep.getPreparation({ businessId: user.businessId, preparationId: recordId }),
    );
    return NextResponse.json({ preparation: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}
