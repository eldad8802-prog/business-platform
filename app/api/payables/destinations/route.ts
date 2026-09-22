import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalPositiveInt,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as dest from "@/lib/services/payables/payables-destination.service";

export const runtime = "nodejs";

/**
 * Payment destinations — where a payee is paid TO. Masked everywhere: the
 * full account number is never in a list; see /[id]/reveal for the one audited
 * single-row read.
 */
export async function GET(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const payeeIdRaw = req.nextUrl.searchParams.get("payeeId");
    const payeeId = payeeIdRaw ? Number(payeeIdRaw) : null;
    if (payeeIdRaw && (!Number.isInteger(payeeId) || (payeeId ?? 0) <= 0)) {
      throw new ValidationError("payeeId must be a positive integer");
    }
    const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      dest.listDestinations({ businessId: user.businessId, payeeId, includeArchived }),
    );
    return NextResponse.json({ destinations: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}

export async function POST(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const body = await readJsonBody(req);
    const payeeId = optionalPositiveInt(body, "payeeId");
    if (!payeeId) throw new ValidationError("payeeId is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      dest.createDestination({
        businessId: user.businessId,
        actorUserId: user.id,
        payeeId,
        label: body.label,
        beneficiaryName: body.beneficiaryName,
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
