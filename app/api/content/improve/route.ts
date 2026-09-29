import { NextRequest, NextResponse } from "next/server";
import { improveContent } from "@/lib/services/content-improve.service";
import { getCurrentUser } from "@/lib/auth";
import {
  CONTENT_EVENT_CONTENT_EDITED,
  ContentDecisionNotFoundError,
  recordContentDecision,
} from "@/lib/services/content/content-decision.evidence";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const {
      mode,
      goal,
      intent,
      audienceDescription,
      selectedFormat,
      script,
      instructions,
      userPrompt,
    } = body;

    if (!script || !userPrompt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const result = await improveContent({
      mode,
      goal,
      intent,
      audienceDescription,
      selectedFormat,
      script,
      instructions: Array.isArray(instructions) ? instructions : [],
      userPrompt,
    });

    const contentRunId = Number(body.contentRunId);
    const variantKey = typeof body.variantKey === "string" ? body.variantKey.trim() : "";
    if (Number.isInteger(contentRunId) && contentRunId > 0 && variantKey) {
      try {
        await recordContentDecision({
          businessId: user.businessId,
          actorUserId: user.id,
          contentRunId,
          variantKey,
          eventType: CONTENT_EVENT_CONTENT_EDITED,
        });
      } catch (decisionError) {
        if (!(decisionError instanceof ContentDecisionNotFoundError)) {
          console.error("content edit evidence failed:", decisionError);
        }
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to improve content" },
      { status: 500 }
    );
  }
}