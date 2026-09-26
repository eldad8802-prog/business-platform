import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { changeRecurringAmountFrom } from "@/lib/services/payables/payables.service";
import {
  amountString,
  handlePayablesError,
  parseId,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — "from <effectiveFrom> the amount is <amount>" for a RECURRING
 * commitment. Occurrences before the effective date keep their amounts, so
 * every past day's cost stays what it was; a paid occurrence on or after it
 * refuses the change (409) rather than being rewritten under its payment.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const commitmentId = parseId(id, "commitment id");
    const body = await readJsonBody(req);

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      changeRecurringAmountFrom({
        businessId: user.businessId,
        commitmentId,
        effectiveFrom: requiredDate(body, "effectiveFrom"),
        amount: amountString(body, "amount"),
        actorUserId: user.id,
      }),
    );

    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
