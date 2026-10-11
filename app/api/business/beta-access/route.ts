import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { resolveBetaAccess } from "@/lib/beta/beta-access-policy";

/**
 * GET /api/business/beta-access — what the signed-in business's screens should show as "בקרוב".
 *
 * Display only. The server refuses each gated action on its own (lib/beta/beta-gate.ts); a client that
 * ignored this answer would still be refused. The business is the session's own — never a caller-supplied id.
 * With the switch off every value is false and no table is read.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const access = await resolveBetaAccess(user.businessId);
    return NextResponse.json(
      { comingSoon: access.comingSoon },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return handleError(error);
  }
}
