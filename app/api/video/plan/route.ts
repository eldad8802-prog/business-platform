import { buildVideoPlan } from "@/lib/services/video-plan.service";
import { getBusinessContentProfile } from "@/lib/services/business-content-profile.service";

type Goal = "leads" | "trust" | "exposure" | "sales";
type ContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";

type SelectedFormat = "reel" | "video" | "image" | "post";
type SelectedPlatform = "instagram" | "tiktok" | "facebook";
type Mode = "ai" | "camera" | "voice";
type VideoType = "SHORT" | "MID" | "FULL";

type DirectionInput = {
  id?: string;
  title?: string;
  description?: string;
  whyItFits?: string;
  type?: string;
  strategy?: string;
  tone?: string;
  pace?: string;
  recommendedFormat?: SelectedFormat;
  score?: number;
};

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

type VideoDecision = {
  videoType: VideoType;
  durationSeconds: number;
  structure: string[];
  pace: "fast" | "medium" | "slow";
  hookStyle:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";
  ctaStyle:
    | "message_now"
    | "book_now"
    | "buy_now"
    | "follow"
    | "learn_more";
  reasoning: string;
};

function normalizeText(value?: string) {
  return (value || "").trim().toLowerCase();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

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

function decideVideoType(input: {
  goal?: Goal;
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
  selectedDirection?: DirectionInput;
  businessProfile: ReturnType<typeof getBusinessContentProfile>;
}): VideoDecision {
  const goal = normalizeText(input.goal);
  const angle = normalizeText(input.contentAngle);
  const prompt = normalizeText(input.contentGoalPrompt);
  const directionTitle = normalizeText(input.selectedDirection?.title);
  const directionDescription = normalizeText(input.selectedDirection?.description);
  const directionWhyItFits = normalizeText(input.selectedDirection?.whyItFits);

  const combined = [
    goal,
    angle,
    prompt,
    directionTitle,
    directionDescription,
    directionWhyItFits,
  ]
    .filter(Boolean)
    .join(" ");

  const profile = input.businessProfile;

  let videoType: VideoType = profile.recommendedVideoType;
  let durationSeconds =
    videoType === "SHORT" ? 15 : videoType === "MID" ? 28 : 42;

  if (input.selectedFormat === "video") {
    videoType = "FULL";
    durationSeconds = Math.max(durationSeconds, 40);
  }

  if (input.selectedFormat === "reel" && videoType === "FULL") {
    durationSeconds = 40;
  }

  const painIndicators = [
    "בעיה",
    "קשה",
    "לא מצליח",
    "לא מצליחה",
    "לא עובד",
    "למה",
    "טעויות",
    "טעות",
    "לפני שאתם",
    "לפני שאתן",
    "אם אתם",
    "אם אתן",
    "התנגדות",
    "כאב",
    "pain",
    "show_difference",
    "trust",
  ];

  const explanationIndicators = [
    "איך",
    "שלבים",
    "טיפ",
    "טיפים",
    "הסבר",
    "מה לעשות",
    "דרך",
    "שיטה",
    "explain",
    "show_result",
  ];

  if (
    includesAny(combined, painIndicators) &&
    (profile.trustLevel === "high" || profile.salesCycle === "long")
  ) {
    videoType = "FULL";
    durationSeconds = Math.max(durationSeconds, 40);
  } else if (
    includesAny(combined, explanationIndicators) &&
    videoType === "SHORT"
  ) {
    videoType = "MID";
    durationSeconds = 25;
  }

  let structure: string[] = ["hook", "value", "cta"];

  switch (profile.contentStyle) {
    case "transformation":
      structure =
        videoType === "SHORT"
          ? ["hook", "result", "cta"]
          : videoType === "MID"
          ? ["hook", "pain", "solution", "cta"]
          : ["hook", "pain", "explanation", "solution", "proof", "cta"];
      break;

    case "authority":
      structure =
        videoType === "SHORT"
          ? ["hook", "trust", "cta"]
          : videoType === "MID"
          ? ["hook", "context", "explanation", "cta"]
          : ["hook", "pain", "explanation", "proof", "trust", "cta"];
      break;

    case "testimonial":
      structure =
        videoType === "SHORT"
          ? ["hook", "proof", "cta"]
          : videoType === "MID"
          ? ["hook", "context", "proof", "cta"]
          : ["hook", "pain", "solution", "proof", "cta"];
      break;

    case "offer":
      structure =
        videoType === "SHORT"
          ? ["hook", "offer", "cta"]
          : videoType === "MID"
          ? ["hook", "context", "offer", "cta"]
          : ["hook", "pain", "offer", "proof", "cta"];
      break;

    case "demonstration":
      structure =
        videoType === "SHORT"
          ? ["hook", "value", "cta"]
          : videoType === "MID"
          ? ["hook", "context", "solution", "cta"]
          : ["hook", "pain", "solution", "proof", "cta"];
      break;

    case "explanation":
    default:
      structure =
        videoType === "SHORT"
          ? ["hook", "value", "cta"]
          : videoType === "MID"
          ? ["hook", "context", "solution", "cta"]
          : ["hook", "pain", "explanation", "solution", "proof", "cta"];
      break;
  }

  let pace: "fast" | "medium" | "slow" =
    profile.visualStrength === "high"
      ? "fast"
      : profile.visualStrength === "medium"
      ? "medium"
      : "slow";

  if (input.selectedPlatform === "tiktok") {
    pace = "fast";
  } else if (input.selectedPlatform === "instagram") {
    pace = pace === "slow" ? "medium" : pace;
  } else if (input.selectedPlatform === "facebook" && pace === "fast") {
    pace = "medium";
  }

  const hookStyle = profile.hookPriority;
  let ctaStyle = profile.ctaStyle;

  if (input.goal === "trust") {
    ctaStyle = "follow";
  } else if (input.goal === "sales") {
    ctaStyle =
      profile.offerType === "product" ? "buy_now" : profile.ctaStyle;
  } else if (input.goal === "leads") {
    ctaStyle =
      profile.offerType === "service" || profile.offerType === "hybrid"
        ? "message_now"
        : profile.ctaStyle;
  } else if (input.goal === "exposure") {
    ctaStyle = "follow";
  }

  return {
    videoType,
    durationSeconds,
    structure,
    pace,
    hookStyle,
    ctaStyle,
    reasoning: `Built from business profile (${profile.marketCategory}, ${profile.contentStyle}, trust=${profile.trustLevel}, visual=${profile.visualStrength}) and goal/platform context.`,
  };
}

export async function POST(req: Request) {
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

    const businessProfile = getBusinessContentProfile({
      businessType: body.businessType,
      businessCategory: body.businessCategory,
      businessName: body.businessName,
      services: body.services ?? [],
      products: body.products ?? [],
      targetAudience: body.audienceTypes ?? [],
      brandTone: body.brandTone ?? body.selectedDirection?.tone,
      primaryGoal: body.goal,
      priceLevel: body.priceLevel,
      differentiators: body.differentiators ?? [],
    });

    const decision = decideVideoType({
      goal: body.goal,
      contentAngle: body.contentAngle,
      contentGoalPrompt: body.contentGoalPrompt,
      selectedFormat: body.selectedFormat,
      selectedPlatform: body.selectedPlatform,
      selectedDirection: body.selectedDirection,
      businessProfile,
    });

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

      videoType: decision.videoType,
      durationSeconds: decision.durationSeconds,
      structure: decision.structure,
      pace: decision.pace,
      hookStyle: decision.hookStyle,
      ctaStyle: decision.ctaStyle,
      decisionReasoning: decision.reasoning,
    };

    const result = await buildVideoPlan(planInput);

    return Response.json({
      success: true,
      variants: result?.variants ?? [],
      videoDecision: decision,
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