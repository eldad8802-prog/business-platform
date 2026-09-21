import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { archiveBusinessBankAccount } from "@/lib/services/payables/payables-bank-account.service";
import { handlePayablesError, parseId } from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — archive. Never a delete: cheques already drawn on the account keep
 * their history. Archiving only stops new cheques from being drawn on it.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const bankAccountId = parseId(id, "bank account id");

    const account = await runWithTenantContext({ businessId: user.businessId }, () =>
      archiveBusinessBankAccount({
        businessId: user.businessId,
        actorUserId: user.id,
        bankAccountId,
      }),
    );
    return NextResponse.json({ account });
  } catch (error) {
    return handlePayablesError(error);
  }
}
