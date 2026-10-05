import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import { composerEnabled, openAiComposerProvider } from "@/lib/services/landing/composer/composer-provider";
import { composeLandingPreviewForBusiness, LandingStrategyNotAvailableError } from "@/lib/services/landing/composer/landing-blueprint.service";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

/**
 * P3-C — compose a structured landing blueprint for ONE of the session business's CURRENT strategies.
 * Body: { strategyId } — a server-issued id from GET /api/business/landing-strategies. Every other
 * field is ignored: no business id, no strategy object, no refs, no constraints are accepted from the
 * client. The strategy set is recomputed server-side in the tenant transaction. Internal (owner) only;
 * P3-D adds the server-built RenderModel (owner preview; actions drawn, never performed).
 * nothing is stored or published. Rate-limited (LANDING_COMPOSE, fail-closed).
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
    return NextResponse.json({ error: "Invalid body", code: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
  }

  try {
    // P3-D: the same canonical composition path, plus the server-built deterministic render model for the
    // owner preview (null when not composed, or when the renderer refuses the blueprint — renderError).
    const { result, renderModel, renderError } = await composeLandingPreviewForBusiness(user.businessId, strategyId, {
      model: composerEnabled() ? openAiComposerProvider() : null,
    });
    return NextResponse.json({ result, renderModel, renderError }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof LandingStrategyNotAvailableError) {
      return NextResponse.json({ error: error.message, code: "STRATEGY_NOT_AVAILABLE" }, { status: 409, headers: NO_STORE });
    }
    return trustErrorResponse(error, "POST /api/business/landing-blueprint");
  }
}
