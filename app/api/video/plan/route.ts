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
import { getCurrentUser } from "@/lib/auth";

type VideoPlanRequestBody = {
  mode?: Mode;
  goal?: Goal;
  intent?: string;
  audienceTypes?: string[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;

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

    const decisionInput: DecisionInput = {
      goal: body.goal,
      intent: body.intent,
      contentAngle: body.contentAngle,
      contentGoalPrompt: body.contentGoalPrompt,
      selectedFormat: body.selectedFormat,
      selectedPlatform: body.selectedPlatform,
      selectedDirection: body.selectedDirection,
      brandTone: body.brandTone ?? body.selectedDirection?.tone,
    };

    const { decision, businessProfile } = runContentDecisionEngine({
      decisionInput,
      businessProfileRequest: {
        businessType: body.businessType,
        businessCategory: body.businessCategory,
        businessName: body.businessName,
        services: body.services,
        products: body.products,
        audienceTypes: body.audienceTypes,
        brandTone: body.brandTone,
        primaryGoal: body.goal,
        priceLevel: body.priceLevel,
        differentiators: body.differentiators,
        selectedDirectionTone: body.selectedDirection?.tone,
      },
    });

    const lm = decision.legacyMapping;

    const planInput = {
      mode: body.mode,
      goal: body.goal,
      intent: body.intent,
      audienceTypes: body.audienceTypes ?? [],
      contentAngle: body.contentAngle,
      contentGoalPrompt: body.contentGoalPrompt ?? "",

      selectedDirection: body.selectedDirection,
      selectedFormat:
        body.selectedFormat ??
        body.selectedDirection?.recommendedFormat ??
        "reel",
      selectedPlatform: body.selectedPlatform ?? "instagram",

      businessType: body.businessType,
      businessCategory: body.businessCategory,
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

    const result = await buildVideoPlan(planInput);

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
