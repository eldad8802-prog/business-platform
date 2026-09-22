import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
  parseId,
} from "@/lib/services/payables/payables-http";
import * as prep from "@/lib/services/payables/payables-preparation.service";

export const runtime = "nodejs";

/**
 * The owner approves the prepared payment. This FREEZES what will be paid
 * (amount, source, destination) — it still moves no money.
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
      prep.approvePreparation({ businessId: user.businessId, actorUserId: user.id, preparationId: recordId }),
    );
    return NextResponse.json({ preparation: result });
  } catch (error) {
    return handlePayablesError(error);
  }
}
