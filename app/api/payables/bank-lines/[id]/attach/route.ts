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
 * The line is evidence of an EXISTING payment. No money moves.
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
    const paymentId = optionalPositiveInt(body, "paymentId");
    if (!paymentId) throw new ValidationError("paymentId is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.attachObservationToPayment({ businessId: user.businessId, actorUserId: user.id, externalTransactionId: recordId, paymentId }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
