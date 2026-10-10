import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { approveLandingVersion } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse, versionIdParam, versionNotFound } from "@/lib/services/landing/persistence/landing-http";

/**
 * P3-E — the owner approves their CURRENT draft as the chosen version. The body is never read: the
 * approver and the time come from the server session and clock. Approval is not publication, and it is
 * allowed while the page is not publish-ready (today's missing items are returned). No model call.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  const id = await versionIdParam(params);
  if (id === null) return versionNotFound();
  try {
    return NextResponse.json(await approveLandingVersion({ businessId: user.businessId, userId: user.id, versionId: id }), { headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "POST /api/business/landing/versions/[id]/approve");
  }
}
