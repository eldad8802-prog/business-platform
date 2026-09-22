import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";
import * as outbound from "@/lib/services/payables/payables-outbound.service";

export const runtime = "nodejs";

/**
 * Send an approved prepared payment to an outbound provider. No outbound
 * provider is connected today; this refuses with an explanation until one is.
 * Requires confirm: true and a per-confirmation idempotencyKey.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const recordId = parseId(id, "id");
    const body = await readJsonBody(req);
    const provider = optionalString(body, "provider");
    const idempotencyKey = optionalString(body, "idempotencyKey");
    if (!provider) throw new ValidationError("provider is required");
    if (!idempotencyKey) throw new ValidationError("idempotencyKey is required");
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      outbound.requestExecution({
        businessId: user.businessId,
        actorUserId: user.id,
        preparationId: recordId,
        provider,
        idempotencyKey,
        confirm: body.confirm === true,
      }),
    );
    return NextResponse.json({ execution: result }, { status: 202 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
