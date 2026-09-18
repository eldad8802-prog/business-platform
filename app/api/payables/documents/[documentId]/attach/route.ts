import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { attachDocumentEvidence } from "@/lib/services/payables/payables-reconciliation.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the owner confirms this document is the receipt for a payment they
 * already recorded.
 *
 * Attaches evidence and moves NO money. This is the half of the double-count
 * invariant that keeps a later receipt from becoming a second payment.
 */
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

    const paymentId = Number(body.paymentId);
    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      throw new ValidationError("paymentId is required");
    }

    const evidence = await runWithTenantContext({ businessId: user.businessId }, () =>
      attachDocumentEvidence({
        businessId: user.businessId,
        documentId: id,
        paymentId,
        actorUserId: user.id,
        note: optionalString(body, "note"),
      }),
    );

    return NextResponse.json({ evidence }, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
