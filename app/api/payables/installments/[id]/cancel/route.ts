import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { cancelInstallment } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — cancel an installment that should never have been scheduled.
 *
 * Refused while active money is still applied to it. The owner reverses the
 * allocation first, deliberately and audited, rather than having a cancellation
 * quietly orphan a payment — which is the sort of thing that later reads as
 * money that simply evaporated.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const installmentId = parseId(id, "installment id");
    const body = await readJsonBody(req);

    const installment = await runWithTenantContext({ businessId: user.businessId }, () =>
      cancelInstallment({
        businessId: user.businessId,
        installmentId,
        actorUserId: user.id,
        reason: optionalString(body, "reason"),
      }),
    );

    return NextResponse.json({ installment });
  } catch (error) {
    return handlePayablesError(error);
  }
}
