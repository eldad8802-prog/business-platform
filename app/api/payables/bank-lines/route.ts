import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  amountString,
  handlePayablesError,
  optionalPositiveInt,
  optionalString,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * Bank lines — what the owner's bank reported. Observations, never payments.
 */
export async function GET(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const scope = req.nextUrl.searchParams.get("scope") === "all" ? "all" : "open";
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.listObservations({ businessId: user.businessId, scope }),
    );
    return NextResponse.json({ lines: result });
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
    const direction = body.direction === "CREDIT" ? "CREDIT" : "DEBIT";
    const clientKey = optionalString(body, "clientKey");
    if (!clientKey) throw new ValidationError("clientKey is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.recordObservationManually({
        businessId: user.businessId,
        actorUserId: user.id,
        clientKey,
        sourceBankAccountId: optionalPositiveInt(body, "sourceBankAccountId"),
        bookedAt: requiredDate(body, "bookedAt"),
        amount: amountString(body, "amount"),
        direction,
        counterpartyName: optionalString(body, "counterpartyName"),
        reference: optionalString(body, "reference"),
        description: optionalString(body, "description"),
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
