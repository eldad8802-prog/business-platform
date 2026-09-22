import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as dest from "@/lib/services/payables/payables-destination.service";

export const runtime = "nodejs";

/**
 * Replace with a new account, atomically: the old one is archived and the new
 * one links back to it.
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
      dest.replaceDestination({
        businessId: user.businessId,
        actorUserId: user.id,
        destinationId: recordId,
        label: body.label,
        beneficiaryName: body.beneficiaryName,
        bankCode: body.bankCode,
        branchCode: body.branchCode,
        accountNumber: body.accountNumber,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
