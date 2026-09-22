import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalPositiveInt,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * The line is the transfer of an approved prepared payment.
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
    const preparationId = optionalPositiveInt(body, "preparationId");
    if (!preparationId) throw new ValidationError("preparationId is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.completePreparationFromObservation({ businessId: user.businessId, actorUserId: user.id, externalTransactionId: recordId, preparationId }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
