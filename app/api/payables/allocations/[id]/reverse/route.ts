import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { reverseAllocation } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — reverse one allocation: the payment happened, it was applied to the
 * wrong installment.
 *
 * The row is kept and stamped, never removed. The money returns to the
 * payment's unallocated balance and the installment goes back to owing what it
 * owed, and both facts stay visible afterwards — a deleted allocation would
 * leave the ledger arithmetically correct and historically silent.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const allocationId = parseId(id, "allocation id");
    const body = await readJsonBody(req);

    const allocation = await runWithTenantContext({ businessId: user.businessId }, () =>
      reverseAllocation({
        businessId: user.businessId,
        allocationId,
        actorUserId: user.id,
        reason: optionalString(body, "reason"),
      }),
    );

    return NextResponse.json({ allocation });
  } catch (error) {
    return handlePayablesError(error);
  }
}
