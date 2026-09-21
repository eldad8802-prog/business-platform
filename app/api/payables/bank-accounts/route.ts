import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  createBusinessBankAccount,
  listBusinessBankAccounts,
} from "@/lib/services/payables/payables-bank-account.service";
import { isBankCryptoConfigured } from "@/lib/services/payables/payables-bank-crypto";
import { handlePayablesError, readJsonBody } from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * GET — the business's own bank accounts, MASKED. There is no response shape in
 * this route family that carries more than the last four digits.
 *
 * `configured` lets the screen say "not available yet" up front instead of
 * letting the owner type an account number only to be refused.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
    const accounts = await runWithTenantContext({ businessId: user.businessId }, () =>
      listBusinessBankAccounts({ businessId: user.businessId, includeArchived }),
    );
    return NextResponse.json({ accounts, configured: isBankCryptoConfigured() });
  } catch (error) {
    return handlePayablesError(error);
  }
}

/**
 * POST — add an account. The coordinates in this body are the only plaintext
 * bank coordinates the platform ever handles; they are sealed before the
 * database is touched and the response carries the masked view only.
 *
 * Coordinates must arrive as STRINGS: a JSON number has already lost its
 * leading zeros, so it is refused rather than accepted and silently wrong.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = await readJsonBody(req);
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      createBusinessBankAccount({
        businessId: user.businessId,
        actorUserId: user.id,
        label: body.label,
        bankCode: body.bankCode,
        branchCode: body.branchCode,
        accountNumber: body.accountNumber,
        isDefault: body.isDefault === true,
        note: body.note,
      }),
    );
    return NextResponse.json(result, { status: result.restored ? 200 : 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
