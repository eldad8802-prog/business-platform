import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { replaceCheque } from "@/lib/services/payables/payables-cheque.service";
import {
  handlePayablesError,
  optionalPositiveInt,
  parseId,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — replace a cheque with a new one. The old row is kept and marked
 * REPLACED; the new row links back to it. Nothing about the old cheque is
 * rewritten to look like the new one.
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

    let status: "PLANNED" | "ISSUED" = "PLANNED";
    if (body.status != null) {
      if (body.status !== "PLANNED" && body.status !== "ISSUED") {
        throw new ValidationError("status must be PLANNED or ISSUED");
      }
      status = body.status;
    }
    let amount: string | null = null;
    if (body.amount != null && body.amount !== "") {
      if (typeof body.amount === "string") amount = body.amount.trim();
      else if (typeof body.amount === "number" && Number.isFinite(body.amount)) amount = String(body.amount);
      else throw new ValidationError("amount must be a decimal");
    }

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      replaceCheque({
        businessId: user.businessId,
        actorUserId: user.id,
        chequeId,
        chequeNumber: body.chequeNumber,
        amount,
        issueDate: requiredDate(body, "issueDate"),
        dueDate: requiredDate(body, "dueDate"),
        sourceBankAccountId: optionalPositiveInt(body, "sourceBankAccountId"),
        status,
        reason: body.reason,
        note: body.note,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
