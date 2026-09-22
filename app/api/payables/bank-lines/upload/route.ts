import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalPositiveInt,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as obs from "@/lib/services/payables/payables-observation.service";

export const runtime = "nodejs";

/**
 * Upload the CSV the owner's bank exports. Idempotent: re-uploading an
 * overlapping statement adds only the lines not already known.
 */
export async function POST(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const body = await readJsonBody(req);
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    if (!csvText.trim()) throw new ValidationError("csvText is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      obs.uploadStatement({
        businessId: user.businessId,
        actorUserId: user.id,
        sourceBankAccountId: optionalPositiveInt(body, "sourceBankAccountId"),
        csvText,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
