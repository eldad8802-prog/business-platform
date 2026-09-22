import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
} from "@/lib/services/payables/payables-http";
import * as outbound from "@/lib/services/payables/payables-outbound.service";

export const runtime = "nodejs";

/**
 * Ask the provider where an execution stands. Only SETTLED records a Payment.
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

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      outbound.refreshExecution({ businessId: user.businessId, actorUserId: user.id, executionId: recordId }),
    );
    return NextResponse.json({ execution: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}
