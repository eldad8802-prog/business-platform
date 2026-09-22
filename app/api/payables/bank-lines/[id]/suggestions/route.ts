import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * Derived candidates for one bank line. Nothing is stored.
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
      obs.suggestForObservation({ businessId: user.businessId, externalTransactionId: recordId }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
