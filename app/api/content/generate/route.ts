import { NextRequest, NextResponse } from "next/server";
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

    const content = await generateAIContent({
      type,
      category,
      goal,
      audience,
      valueType,
      style,
      mode,
    });

    return NextResponse.json({ content });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to generate content" },
      { status: 500 }
    );
  }
}