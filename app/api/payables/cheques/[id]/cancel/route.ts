import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { cancelCheque } from "@/lib/services/payables/payables-cheque.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — cancel a cheque that has not cleared. The row stays; its number is
 * released so the chequebook can record it again if the bank reissues it.
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
      cancelCheque({
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
