import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
} from "@/lib/services/payables/payables-http";
import * as dest from "@/lib/services/payables/payables-destination.service";

export const runtime = "nodejs";

/**
 * Make this the payee's default destination.
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
      dest.setDefaultDestination({ businessId: user.businessId, actorUserId: user.id, destinationId: recordId }),
    );
    return NextResponse.json({ destination: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}
