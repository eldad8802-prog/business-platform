import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * Detach a bank line from a payment. The payment is unchanged.
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
      obs.revokeObservationEvidence({ businessId: user.businessId, actorUserId: user.id, evidenceId: recordId, reason: optionalString(body, "reason") }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
