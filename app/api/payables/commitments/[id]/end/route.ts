import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { endCommitment } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the commitment is in effect up to and including <endsOn>.
 * Unpaid occurrences after it are cancelled; history before it is untouched;
 * a paid occurrence after it refuses the end (409) rather than being stranded.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const commitmentId = parseId(id, "commitment id");
    const body = await readJsonBody(req);

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      endCommitment({
        businessId: user.businessId,
        commitmentId,
        endsOn: requiredDate(body, "endsOn"),
        actorUserId: user.id,
      }),
    );

    return NextResponse.json({ commitment: result.commitment, cancelledInstallmentIds: result.cancelledInstallmentIds });
  } catch (error) {
    return handlePayablesError(error);
  }
}
