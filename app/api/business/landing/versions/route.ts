import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import { composerEnabled, openAiComposerProvider } from "@/lib/services/landing/composer/composer-provider";
import { getLandingOverview, saveLandingVersion } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse } from "@/lib/services/landing/persistence/landing-http";

/** P3-E — the version history of the session business's landing page (no snapshot copy). */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  try {
    const { versions } = await getLandingOverview(user.businessId);
    return NextResponse.json({ versions }, { headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "GET /api/business/landing/versions");
  }
}

/**
 * P3-E — save a new DRAFT version. Body: { strategyId } — a server-issued id of one of the business's
 * CURRENT strategies. Every other field is ignored: no blueprint, status, authority, approver, pointer or
 * business id is ever read from the client. The blueprint is the canonical P3-C composition, recomputed
 * (or reused) on the server; with the composer off nothing can be saved (503 COMPOSER_UNAVAILABLE).
 * Rate-limited with the composer (LANDING_COMPOSE, fail-closed): a save may cost one model call.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  const decision = await checkRateLimit({ bucket: "LANDING_COMPOSE", user: user.id, business: user.businessId, ip: getClientIp(req) });
  if (!decision.allowed) return buildRateLimitResponse(decision);

  let strategyId: unknown;
  try {
    strategyId = ((await req.json()) as { strategyId?: unknown })?.strategyId;
  } catch {
    return NextResponse.json({ error: "Invalid body", code: "INVALID_BODY" }, { status: 400, headers: LANDING_NO_STORE });
  }
  try {
    const saved = await saveLandingVersion(
      { businessId: user.businessId, userId: user.id, strategyId },
      { model: composerEnabled() ? openAiComposerProvider() : null },
    );
    return NextResponse.json(saved, { status: saved.deduplicated ? 200 : 201, headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "POST /api/business/landing/versions");
  }
}
