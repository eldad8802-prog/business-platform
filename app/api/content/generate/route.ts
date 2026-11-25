import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { QuotaExhaustedError, quotaExhaustedBody, requireUsage, settleUsage } from "@/lib/services/subscriptions/usage/usage-meter";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { generateAIContent } from "@/lib/services/ai-content.service";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";

export async function POST(req: NextRequest) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Owner decision 26: abuse ceiling after auth, before any model call.
  const rateDecision = await checkRateLimit({ bucket: "CONTENT_GENERATE", user: user.id, business: user.businessId });
  if (!rateDecision.allowed) return buildRateLimitResponse(rateDecision);

  let aiUnit: string | null = null;
  try {
    const body = await req.json();

    const {
      type,
      category,
      goal,
      audience,
      valueType,
      style,
      mode,
    } = body;

    if (!type) {
      return NextResponse.json(
        { error: "type is required" },
        { status: 400 }
      );
    }

    // Subscriptions stage C — an owner-initiated AI action (ai_owner_actions; Premium only, decision 17): reserved
    // before the provider calls, COUNTED when they returned, UNKNOWN when they failed midway (tokens may be billed).
    aiUnit = `ai:content:${randomUUID()}`;
    await requireUsage({ businessId: user.businessId, metric: "ai_owner_actions", unitKey: aiUnit, source: "content.generate", reserve: true });
    const content = await generateAIContent({
      type,
      category,
      goal,
      audience,
      valueType,
      style,
      mode,
    });

    await settleUsage({ businessId: user.businessId, metric: "ai_owner_actions", unitKey: aiUnit, state: "COUNTED" });
    return NextResponse.json({ content });
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      return NextResponse.json(quotaExhaustedBody(error.decision), { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (aiUnit) await settleUsage({ businessId: user.businessId, metric: "ai_owner_actions", unitKey: aiUnit, state: "UNKNOWN" });
    console.error(error);

    return NextResponse.json(
      { error: "Failed to generate content" },
      { status: 500 }
    );
  }
}