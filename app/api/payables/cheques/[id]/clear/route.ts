import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { clearCheque } from "@/lib/services/payables/payables-cheque.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the OWNER says this cheque cleared.
 *
 * Recorded with provenance OWNER_ASSERTED, and never described as verified:
 * there is no bank feed. The cheque becomes one canonical Payment in the same
 * transaction; a retry returns that same Payment (`replayed`), never a second.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const chequeId = parseId(id, "cheque id");
    const body = await readJsonBody(req);

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      clearCheque({
        businessId: user.businessId,
        actorUserId: user.id,
        chequeId,
        clearedAt: requiredDate(body, "clearedAt"),
      }),
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
