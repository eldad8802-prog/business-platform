import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { createCheque, listCheques } from "@/lib/services/payables/payables-cheque.service";
import { isChequeStatus } from "@/lib/services/payables/payables-cheque-core";
import {
  amountString,
  handlePayablesError,
  optionalPositiveInt,
  optionalString,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/** GET — the cheque register. `scope=open` (default) hides settled history. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const params = req.nextUrl.searchParams;
    const scope = params.get("scope") === "all" ? "all" : "open";
    const rawCommitment = params.get("commitmentId");
    let commitmentId: number | null = null;
    if (rawCommitment) {
      commitmentId = Number(rawCommitment);
      if (!Number.isInteger(commitmentId) || commitmentId <= 0) {
        throw new ValidationError("commitmentId must be a positive integer");
      }
    }

    const cheques = await runWithTenantContext({ businessId: user.businessId }, () =>
      listCheques({ businessId: user.businessId, commitmentId, scope }),
    );
    return NextResponse.json({ cheques });
  } catch (error) {
    return handlePayablesError(error);
  }
}

/**
 * POST — record a cheque, PLANNED (not yet written) or ISSUED (written).
 *
 * `chequeNumber` is kept as the text the owner typed. The server never
 * proposes one: it does not know which chequebook is in the drawer.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = await readJsonBody(req);
    const sourceBankAccountId = optionalPositiveInt(body, "sourceBankAccountId");
    if (!sourceBankAccountId) throw new ValidationError("sourceBankAccountId is required");

    let status: "PLANNED" | "ISSUED" = "PLANNED";
    if (body.status != null) {
      if (!isChequeStatus(body.status) || (body.status !== "PLANNED" && body.status !== "ISSUED")) {
        throw new ValidationError("status must be PLANNED or ISSUED");
      }
      status = body.status;
    }

    const cheque = await runWithTenantContext({ businessId: user.businessId }, () =>
      createCheque({
        businessId: user.businessId,
        actorUserId: user.id,
        chequeNumber: body.chequeNumber,
        amount: amountString(body, "amount"),
        issueDate: requiredDate(body, "issueDate"),
        dueDate: requiredDate(body, "dueDate"),
        sourceBankAccountId,
        commitmentId: optionalPositiveInt(body, "commitmentId"),
        installmentId: optionalPositiveInt(body, "installmentId"),
        payeeId: optionalPositiveInt(body, "payeeId"),
        payeeName: optionalString(body, "payeeName"),
        status,
        note: body.note,
      }),
    );
    return NextResponse.json({ cheque }, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
