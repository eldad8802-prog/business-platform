import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { revealDestinationCoordinates } from "@/lib/services/payables/payables-destination.service";
import { handlePayablesError, parseId } from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the ONE response in the product that carries a payee's full account
 * number: the owner copying it into their bank app to make a prepared transfer.
 * POST (never a cacheable GET), single row, audited on every call, and marked
 * no-store so no browser or proxy keeps a copy.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const destinationId = parseId(id, "destination id");

    const { destination, coordinates } = await runWithTenantContext({ businessId: user.businessId }, () =>
      revealDestinationCoordinates({ businessId: user.businessId, actorUserId: user.id, destinationId }),
    );
    return NextResponse.json(
      { destination, coordinates, readable: coordinates !== null },
      { headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } },
    );
  } catch (error) {
    return handlePayablesError(error);
  }
}
