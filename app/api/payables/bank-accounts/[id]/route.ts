import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { updateBusinessBankAccount } from "@/lib/services/payables/payables-bank-account.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * PATCH — rename, or change the note. The coordinates themselves are not
 * editable: a different account is a different account, added on its own.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const bankAccountId = parseId(id, "bank account id");
    const body = await readJsonBody(req);

    const account = await runWithTenantContext({ businessId: user.businessId }, () =>
      updateBusinessBankAccount({
        businessId: user.businessId,
        actorUserId: user.id,
        bankAccountId,
        label: body.label,
        note: body.note,
      }),
    );
    return NextResponse.json({ account });
  } catch (error) {
    return handlePayablesError(error);
  }
}
