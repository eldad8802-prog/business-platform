import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { rejectMatch } from "@/lib/services/payables/payables-reconciliation.service";
import {
  handlePayablesError,
  optionalPositiveInt,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/** POST — the owner says: not this one. Recorded so it stops being suggested. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { documentId } = await context.params;
    const id = parseId(documentId, "document id");
    const body = await readJsonBody(req);

    const rejection = await runWithTenantContext({ businessId: user.businessId }, () =>
      rejectMatch({
        businessId: user.businessId,
        documentId: id,
        commitmentId: optionalPositiveInt(body, "commitmentId"),
        installmentId: optionalPositiveInt(body, "installmentId"),
        paymentId: optionalPositiveInt(body, "paymentId"),
        reason: optionalString(body, "reason"),
        actorUserId: user.id,
      }),
    );

    return NextResponse.json({ rejection }, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
