import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";
import * as prep from "@/lib/services/payables/payables-preparation.service";

export const runtime = "nodejs";

/**
 * The owner reports: "I made this payment." Recorded as ONE canonical
 * Payment (owner-asserted), only if the approved details are unchanged.
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
      prep.reportPreparationCompleted({
        businessId: user.businessId,
        actorUserId: user.id,
        preparationId: recordId,
        paidAt: requiredDate(body, "paidAt"),
        externalReference: optionalString(body, "externalReference"),
      }),
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
