import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { suggestMatchesForDocument } from "@/lib/services/payables/payables-reconciliation.service";
import { handlePayablesError, parseId } from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * GET — what this document might be.
 *
 * Read-only by construction: it scores current facts and returns them. Calling
 * it a hundred times changes nothing, which is the property that lets the UI
 * refresh suggestions freely without ever risking a write.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { documentId } = await context.params;
    const id = parseId(documentId, "document id");

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      suggestMatchesForDocument({ businessId: user.businessId, documentId: id }),
    );

    return NextResponse.json(result);
  } catch (error) {
    return handlePayablesError(error);
  }
}
