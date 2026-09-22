import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  amountString,
  handlePayablesError,
  optionalPositiveInt,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as prep from "@/lib/services/payables/payables-preparation.service";

export const runtime = "nodejs";

/**
 * "הכן תשלום" — prepared payments. Preparing moves no money and marks
 * nothing paid.
 */
export async function GET(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const cidRaw = req.nextUrl.searchParams.get("commitmentId");
    const commitmentId = cidRaw ? Number(cidRaw) : null;
    if (cidRaw && (!Number.isInteger(commitmentId) || (commitmentId ?? 0) <= 0)) {
      throw new ValidationError("commitmentId must be a positive integer");
    }
    const scope = req.nextUrl.searchParams.get("scope") === "all" ? "all" : "open";
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      prep.listPreparations({ businessId: user.businessId, commitmentId, scope }),
    );
    return NextResponse.json({ preparations: result });
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
    const commitmentId = optionalPositiveInt(body, "commitmentId");
    if (!commitmentId) throw new ValidationError("commitmentId is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      prep.preparePayment({
        businessId: user.businessId,
        actorUserId: user.id,
        commitmentId,
        installmentId: optionalPositiveInt(body, "installmentId"),
        amount: amountString(body, "amount"),
        method: body.method,
        destinationId: optionalPositiveInt(body, "destinationId"),
        sourceBankAccountId: optionalPositiveInt(body, "sourceBankAccountId"),
        reference: body.reference,
        note: body.note,
      }),
    );
    return NextResponse.json({ preparation: result }, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
