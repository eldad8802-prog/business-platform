import { buildVideoPlan } from "@/lib/services/video-plan.service";
import {
  runContentDecisionEngine,
  type DecisionInput,
  type Goal,
  type ContentAngle,
  type SelectedFormat,
  type SelectedPlatform,
  type Mode,
  type DirectionInput,
} from "@/lib/features/content/decision";
import { buildCreativeBlueprint } from "@/lib/features/content/creative-blueprint/creative-blueprint.engine";
import { buildRenderBlueprint } from "@/lib/features/content/render-blueprint/render-blueprint.engine";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { persistContentPlanV1 } from "@/lib/services/content-plan-persistence-v1.service";
import {
  normalizeContentGoalPromptForStorage,
  isSubstantiveContentGoalBrief,
} from "@/lib/content/content-goal-prompt-normalize";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";

type VideoPlanRequestBody = {
  mode?: Mode;
  goal?: Goal;
  intent?: string;
  audienceTypes?: string[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;

  contentArchetypeId?: string;
  /** Optional — human insight Q&A from setup; not merged into `contentGoalPrompt`. */
  contentInsightAnswers?: ContentInsightAnswer[];

  selectedDirection?: DirectionInput;
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;

  businessType?: string;
  businessCategory?: string;
  businessName?: string;
  services?: string[];
  products?: string[];
  brandTone?: string;
  priceLevel?: "budget" | "mid" | "premium";
  differentiators?: string[];
};

function validateBody(body: VideoPlanRequestBody) {
  if (!body.goal) {
    return "missing_goal";
  }

  if (!body.contentAngle) {
    return "missing_content_angle";
  }

  if (!body.selectedDirection) {
    return "missing_selected_direction";
  }

  return null;
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as VideoPlanRequestBody;

    const validationError = validateBody(body);

    if (validationError) {
      return Response.json(
        {
          success: false,
          error: validationError,
        },
        { status: 400 }
      );
    }

    if (!isSubstantiveContentGoalBrief(body.contentGoalPrompt)) {
      return Response.json(
        {
          success: false,
          error: "brief_required",
          message:
            "חסר בריף יעד מפורט. חזרו לשלב ההגדרה והשלימו «מה מקדמים» ו«מה עוצר לקוחות» לפני יצירת סרטון.",
        },
        { status: 400 }
      );
    }

    // ── Business identity resolution ──────────────────────────────────────────
    // Priority: body > DB category > DB subCategory > undefined (falls to "other")
    // DB read is best-effort: failure silently falls back to body values.
    let dbCategory: string | undefined;
    let dbSubCategory: string | undefined;

    try {
      const dbProfile = await prisma.businessProfile.findUnique({
        where: { businessId: user.businessId },
        select: { category: true, subCategory: true },
      });
      dbCategory = dbProfile?.category ?? undefined;
      dbSubCategory = dbProfile?.subCategory ?? undefined;
    } catch {
      // DB unavailable — proceed without profile enrichment
    }

    const resolvedBusinessType =
      body.businessType ?? body.businessCategory ?? dbCategory ?? dbSubCategory;

    // ─────────────────────────────────────────────────────────────────────────

    const normalizedGoalPrompt = normalizeContentGoalPromptForStorage(
      body.contentGoalPrompt ?? ""
    );

    const decisionInput: DecisionInput = {
      goal: body.goal,
      intent: body.intent,
      contentAngle: body.contentAngle,
      contentGoalPrompt: normalizedGoalPrompt ?? body.contentGoalPrompt,
      selectedFormat: body.selectedFormat,
      selectedPlatform: body.selectedPlatform,
      selectedDirection: body.selectedDirection,
      brandTone: body.brandTone ?? body.selectedDirection?.tone,
    };

    const { decision, businessProfile } = runContentDecisionEngine({
      decisionInput,
      businessProfileRequest: {
        businessType: resolvedBusinessType,
        businessCategory: body.businessCategory ?? dbCategory,
        businessName: body.businessName,
        services: body.services,
        products: body.products,
        audienceTypes: body.audienceTypes,
        brandTone: body.brandTone,
        primaryGoal: body.goal,
        priceLevel: body.priceLevel,
        differentiators: body.differentiators,
        selectedDirectionTone: body.selectedDirection?.tone,
        contentGoalPrompt: normalizedGoalPrompt,
      },
    });

    const lm = decision.legacyMapping;

    const planInput = {
      mode: body.mode,
      goal: body.goal,
      intent: body.intent,
      audienceTypes: body.audienceTypes ?? [],
      contentAngle: body.contentAngle,
      contentGoalPrompt: normalizedGoalPrompt ?? "",

      contentArchetypeId: body.contentArchetypeId,

      contentInsightAnswers: Array.isArray(body.contentInsightAnswers)
        ? body.contentInsightAnswers
        : undefined,

      selectedDirection: body.selectedDirection,
      selectedFormat:
        body.selectedFormat ??
        body.selectedDirection?.recommendedFormat ??
        "reel",
      selectedPlatform: body.selectedPlatform ?? "instagram",

      businessType: resolvedBusinessType,
      businessCategory: body.businessCategory ?? dbCategory,
      businessName: body.businessName,
      services: body.services ?? [],
      products: body.products ?? [],
      brandTone: body.brandTone ?? body.selectedDirection?.tone,
      priceLevel: body.priceLevel,
      differentiators: body.differentiators ?? [],

      businessProfile,

      videoType: lm.videoType,
      durationSeconds: lm.durationSeconds,
      structure: lm.structure,
      pace: lm.pace,
      hookStyle: lm.hookStyle,
      ctaStyle: lm.ctaStyle,
      decisionReasoning: decision.decisionReason,
    };

    const blueprint = buildCreativeBlueprint({
      businessProfile,
      decision,
      mode: body.mode,
      selectedFormat: body.selectedFormat ?? body.selectedDirection?.recommendedFormat ?? "reel",
      selectedPlatform: body.selectedPlatform ?? "instagram",
      goal: body.goal,
      contentAngle: body.contentAngle,
      selectedDirection: body.selectedDirection,
      audienceTypes: body.audienceTypes,
      contentGoalPrompt: normalizedGoalPrompt ?? body.contentGoalPrompt,
    });

    const result = await buildVideoPlan({ ...planInput, blueprint });

    await persistContentPlanV1({
      user: { id: user.id, businessId: user.businessId },
      body,
      resolvedBusinessType,
      profileCategory: dbCategory,
      profileSubCategory: dbSubCategory,
      variants: result.variants,
      selectedPlatform: body.selectedPlatform ?? "instagram",
    });

    const renderBlueprint = buildRenderBlueprint(
      blueprint,
      body.selectedPlatform ?? "instagram",
      {
        marketCategory: businessProfile.marketCategory,
        contentStyle: businessProfile.contentStyle,
        trustLevel: businessProfile.trustLevel,
      }
    );

    return Response.json({
      success: true,
      variants: result?.variants ?? [],
      videoDecision: {
        videoType: lm.videoType,
        durationSeconds: lm.durationSeconds,
        structure: lm.structure,
        pace: lm.pace,
        hookStyle: lm.hookStyle,
        ctaStyle: lm.ctaStyle,
        reasoning: decision.decisionReason,
      },
      businessProfile,
      blueprint,
      renderBlueprint,
    });
  } catch (error) {
    console.error("VIDEO PLAN ROUTE ERROR:", error);

    return Response.json(
      {
        success: false,
        error: "failed_to_build_video_plan",
      },
      { status: 500 }
    );
  }
}
