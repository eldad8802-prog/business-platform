import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import {
  CONTENT_EVENT_VARIANT_SELECTED,
  ContentDecisionNotFoundError,
  recordContentDecision,
} from "@/lib/services/content/content-decision.evidence";

export async function POST(req: NextRequest) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { contentRunId?: unknown; variantKey?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const contentRunId = Number(body.contentRunId);
  const variantKey = typeof body.variantKey === "string" ? body.variantKey.trim() : "";

  if (!Number.isInteger(contentRunId) || contentRunId <= 0 || !variantKey) {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  try {
    const recorded = await recordContentDecision({
      businessId: user.businessId,
      actorUserId: user.id,
      contentRunId,
      variantKey,
      eventType: CONTENT_EVENT_VARIANT_SELECTED,
    });

    return NextResponse.json({
      success: true,
      created: recorded.created,
      eventId: recorded.eventId,
      variantKey: recorded.variantKey,
    });
  } catch (error) {
    if (error instanceof ContentDecisionNotFoundError) {
      return NextResponse.json({ error: "content_run_not_found" }, { status: 404 });
    }
    console.error("content decision failed:", error);
    return NextResponse.json({ error: "failed_to_record_decision" }, { status: 500 });
  }
}
