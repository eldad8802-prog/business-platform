import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
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
 * Record a NEW payment evidenced by this line. Refused while a similar
 * payment already exists unless acknowledgeSimilarPayment is true.
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
    const commitmentId = optionalPositiveInt(body, "commitmentId");
    if (!commitmentId) throw new ValidationError("commitmentId is required");
    const installmentId = optionalPositiveInt(body, "installmentId");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.recordPaymentFromObservation({
        businessId: user.businessId,
        actorUserId: user.id,
        externalTransactionId: recordId,
        commitmentId,
        installmentIds: installmentId ? [installmentId] : null,
        method: optionalString(body, "method"),
        acknowledgeSimilarPayment: body.acknowledgeSimilarPayment === true,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
