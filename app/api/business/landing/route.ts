import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { composerEnabled } from "@/lib/services/landing/composer/composer-provider";
import { getLandingOverview } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse } from "@/lib/services/landing/persistence/landing-http";

/**
 * P3-E — the session business's landing page: current approved version, current draft (each with today's
 * deterministic readiness) and the full version history. Owner only; no composer, no model call.
 * Nothing here is published.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  try {
    const overview = await getLandingOverview(user.businessId);
    return NextResponse.json({ ...overview, composerEnabled: composerEnabled() }, { headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "GET /api/business/landing");
  }
}
