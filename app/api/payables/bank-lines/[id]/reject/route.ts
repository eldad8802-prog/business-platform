import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalPositiveInt,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * The owner says this line is NOT that payment / installment.
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
      obs.rejectObservationPairing({
        businessId: user.businessId,
        actorUserId: user.id,
        externalTransactionId: recordId,
        paymentId: optionalPositiveInt(body, "paymentId"),
        installmentId: optionalPositiveInt(body, "installmentId"),
        reason: optionalString(body, "reason"),
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
