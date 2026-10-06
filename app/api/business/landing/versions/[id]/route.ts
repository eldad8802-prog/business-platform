import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { getLandingVersionDetail } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse, versionIdParam, versionNotFound } from "@/lib/services/landing/persistence/landing-http";

/**
 * P3-E — one saved version of the session business's page, for the owner preview: snapshot integrity,
 * the readiness recorded when it was composed, today's readiness, and the deterministic render model
 * (today's approved facts / assets; actions drawn, never performed). No composer, no model call.
 * A version of another business is "not found".
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  const id = await versionIdParam(params);
  if (id === null) return versionNotFound();
  try {
    return NextResponse.json(await getLandingVersionDetail(user.businessId, id), { headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "GET /api/business/landing/versions/[id]");
  }
}
