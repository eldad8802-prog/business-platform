import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { bounceCheque } from "@/lib/services/payables/payables-cheque.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the cheque bounced. If the owner had already marked it cleared, the
 * Payment that produced is VOIDED (recorded, never deleted) and every amount it
 * applied stops counting.
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

    const cheque = await runWithTenantContext({ businessId: user.businessId }, () =>
      bounceCheque({
        businessId: user.businessId,
        actorUserId: user.id,
        chequeId,
        reason: body.reason,
      }),
    );
    return NextResponse.json({ cheque });
  } catch (error) {
    return handlePayablesError(error);
  }
}
