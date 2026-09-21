import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { advanceCheque } from "@/lib/services/payables/payables-cheque.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

const ADVANCE_TARGETS = ["ISSUED", "DELIVERED", "PRESENTED"] as const;

/**
 * POST — a plain forward step: written, handed over, deposited. No money
 * moves on any of these; CLEARED, BOUNCED, CANCELLED and REPLACED each have
 * their own route because each one means something to the ledger.
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
    const to = body.to;
    if (typeof to !== "string" || !(ADVANCE_TARGETS as readonly string[]).includes(to)) {
      throw new ValidationError("to must be one of " + ADVANCE_TARGETS.join(", "));
    }

    const cheque = await runWithTenantContext({ businessId: user.businessId }, () =>
      advanceCheque({
        businessId: user.businessId,
        actorUserId: user.id,
        chequeId,
        to: to as (typeof ADVANCE_TARGETS)[number],
      }),
    );
    return NextResponse.json({ cheque });
  } catch (error) {
    return handlePayablesError(error);
  }
}
