import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { revokeDocumentEvidence } from "@/lib/services/payables/payables-reconciliation.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — detach a document from a payment.
 *
 * The row is kept and stamped, never deleted, which is exactly why the
 * double-count index is partial on `revokedAt IS NULL`: undoing a mistake must
 * not be impossible, and must not erase the fact that it happened.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const evidenceId = parseId(id, "evidence id");
    const body = await readJsonBody(req);

    const evidence = await runWithTenantContext({ businessId: user.businessId }, () =>
      revokeDocumentEvidence({
        businessId: user.businessId,
        evidenceId,
        reason: optionalString(body, "reason"),
        actorUserId: user.id,
      }),
    );

    return NextResponse.json({ evidence });
  } catch (error) {
    return handlePayablesError(error);
  }
}
