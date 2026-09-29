import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import { listOpenProposals } from "@/lib/intake/identity/proposals";

/**
 * GET /api/intake/identity-proposals — the owner's open identity proposals
 * (Business Intake M4). Tenant = the session user's business, never a request
 * value. Returns evidence CATEGORIES and ids only — never an identifier value.
 */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const proposals = await runWithTenantContext({ businessId: user.businessId }, () =>
      listOpenProposals(user.businessId)
    );
    return NextResponse.json({ proposals });
  } catch (error) {
    return handleError(error);
  }
}
