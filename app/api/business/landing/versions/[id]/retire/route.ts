import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { retireLandingDraft } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse, versionIdParam, versionNotFound } from "@/lib/services/landing/persistence/landing-http";

/** P3-E — the owner discards their CURRENT draft (it stays in the history as RETIRED; nothing is deleted). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  const id = await versionIdParam(params);
  if (id === null) return versionNotFound();
  try {
    return NextResponse.json(await retireLandingDraft({ businessId: user.businessId, userId: user.id, versionId: id }), { headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "POST /api/business/landing/versions/[id]/retire");
  }
}
