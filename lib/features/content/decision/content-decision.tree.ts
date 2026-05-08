import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type {
  ContentDecision,
  ContentType,
  DecisionInput,
  Intent,
  DecisionInsight,
  DecisionInsightDriver,
  DecisionInsightsBundle,
  LegacyVideoPlanMapping,
  RuleId,
  TemplateType,
  VideoLengthType,
  VisualMode,
} from "./types";

function normalizeText(value?: string) {
  return (value || "").trim().toLowerCase();
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeIntent(value?: string): Intent | undefined {
  const text = (value || "").trim().toLowerCase();
  switch (text) {
    case "message":
    case "book":
    case "follow":
    case "learn_more":
      return text;
    default:
      return undefined;
  }
}

function resolveCtaStylePhase1(params: {
  goal?: DecisionInput["goal"];
  intent?: DecisionInput["intent"];
}): LegacyVideoPlanMapping["ctaStyle"] {
  const intent = normalizeIntent(typeof params.intent === "string" ? params.intent : undefined);
  if (intent) {
    switch (intent) {
      case "message":
        return "message_now";
      case "book":
        return "book_now";
      case "follow":
        return "follow";
      case "learn_more":
        return "learn_more";
      default:
        return "learn_more";
    }
  }

  switch (params.goal) {
    case "leads":
      return "message_now";
    case "trust":
      return "follow";
    case "exposure":
      return "follow";
    case "sales":
      return "learn_more";
    default:
      return "message_now";
  }
}

function buildInsightDrivers(input: {
  goal?: DecisionInput["goal"];
  intentRaw?: DecisionInput["intent"];
  intentResolved?: Intent;
  selectedFormat?: DecisionInput["selectedFormat"];
  businessRecommendedVideoType: BusinessContentProfile["recommendedVideoType"];
  businessSalesCycle: BusinessContentProfile["salesCycle"];
  businessTrustLevel: BusinessContentProfile["trustLevel"];
  painMatched: boolean;
  explanationMatched: boolean;
}): {
  base: DecisionInsightDriver[];
  intent: DecisionInsightDriver[];
  video: DecisionInsightDriver[];
} {
  const base: DecisionInsightDriver[] = [];
  if (input.goal) {
    base.push({ key: "goal", value: input.goal, role: "input" });
  }

  const intentDrivers: DecisionInsightDriver[] = [];
  if (typeof input.intentRaw === "string" && input.intentRaw.trim()) {
    intentDrivers.push({
      key: "intent",
      value: input.intentRaw.trim(),
      role: "input",
    });
  }
  if (input.intentResolved) {
    intentDrivers.push({
      key: "intentResolved",
      value: input.intentResolved,
      role: "derived",
    });
  }

  const videoDrivers: DecisionInsightDriver[] = [
    {
      key: "selectedFormat",
      value: input.selectedFormat ?? "",
      role: "input",
    },
    {
      key: "business.recommendedVideoType",
      value: input.businessRecommendedVideoType,
      role: "profile",
    },
    { key: "business.salesCycle", value: input.businessSalesCycle, role: "profile" },
    { key: "business.trustLevel", value: input.businessTrustLevel, role: "profile" },
    { key: "indicator.painMatched", value: input.painMatched, role: "derived" },
    {
      key: "indicator.explanationMatched",
      value: input.explanationMatched,
      role: "derived",
    },
  ];

  return { base, intent: intentDrivers, video: videoDrivers };
}

function enforceBudget(card: DecisionInsight): DecisionInsight {
  return {
    ...card,
    drivers: card.drivers.slice(0, 5),
    rulesFired: card.rulesFired.slice(0, 3),
  };
}

function mapContentStyleToContentType(
  contentStyle: BusinessContentProfile["contentStyle"]
): ContentType {
  switch (contentStyle) {
    case "offer":
      return "OFFER";
    case "testimonial":
      return "TRUST";
    case "demonstration":
      return "DEMONSTRATION";
    case "transformation":
      return "PROBLEM_SOLUTION";
    case "authority":
    case "explanation":
      return "EDUCATIONAL";
    default:
      return "EDUCATIONAL";
  }
}

function visualStrengthToMode(
  visualStrength: BusinessContentProfile["visualStrength"]
): VisualMode {
  if (visualStrength === "high") return "high";
  if (visualStrength === "medium") return "medium";
  return "low";
}

/**
 * Core deterministic rules previously inline in `app/api/video/plan/route.ts` (`decideVideoType`).
 */
export function evaluateContentDecisionTree(
  input: DecisionInput,
  businessProfile: BusinessContentProfile
): Pick<
  ContentDecision,
  | "primaryGoal"
  | "contentType"
  | "videoType"
  | "structure"
  | "hookStyle"
  | "pace"
  | "targetDurationSeconds"
  | "tone"
  | "ctaType"
  | "templateType"
  | "visualMode"
  | "decisionReason"
  | "businessFit"
  | "platformFit"
  | "legacyMapping"
  | "decisionInsights"
> {
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

  const profile = businessProfile;

  let videoType: VideoLengthType = profile.recommendedVideoType;
  let durationSeconds =
    videoType === "SHORT" ? 15 : videoType === "MID" ? 28 : 42;

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

  const painMatched = includesAny(combined, painIndicators);
  const explanationMatched = includesAny(combined, explanationIndicators);

  const intentResolved = normalizeIntent(
    typeof input.intent === "string" ? input.intent : undefined
  );

  const drivers = buildInsightDrivers({
    goal: input.goal,
    intentRaw: input.intent,
    intentResolved,
    selectedFormat: input.selectedFormat,
    businessRecommendedVideoType: profile.recommendedVideoType,
    businessSalesCycle: profile.salesCycle,
    businessTrustLevel: profile.trustLevel,
    painMatched,
    explanationMatched,
  });

  const rulesVideo: RuleId[] = ["video.profile_recommended_default"];

  if (input.selectedFormat === "video") {
    videoType = "FULL";
    durationSeconds = Math.max(durationSeconds, 40);
    rulesVideo.push("video.format_video_forces_full");
  }

  if (input.selectedFormat === "reel" && videoType === "FULL") {
    durationSeconds = 40;
    rulesVideo.push("video.reel_caps_full_duration");
  }

  if (painMatched && (profile.trustLevel === "high" || profile.salesCycle === "long")) {
    videoType = "FULL";
    durationSeconds = Math.max(durationSeconds, 40);
    rulesVideo.push("video.pain_longform_escalation");
  } else if (
    explanationMatched &&
    videoType === "SHORT"
  ) {
    videoType = "MID";
    durationSeconds = 25;
    rulesVideo.push("video.explanation_short_to_mid");
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
  const ctaStyle = resolveCtaStylePhase1({
    goal: input.goal,
    intent: input.intent,
  });

  const rulesCta: RuleId[] = [];
  if (intentResolved) {
    rulesCta.push("cta.intent_override");
  } else {
    switch (input.goal) {
      case "trust":
        rulesCta.push("cta.default_by_goal_trust");
        break;
      case "exposure":
        rulesCta.push("cta.default_by_goal_exposure");
        break;
      case "sales":
        rulesCta.push("cta.default_by_goal_sales");
        break;
      case "leads":
      default:
        rulesCta.push("cta.default_by_goal_leads");
        break;
    }
  }

  const legacyMapping: LegacyVideoPlanMapping = {
    videoType,
    durationSeconds,
    structure,
    pace,
    hookStyle,
    ctaStyle,
  };

  const primaryGoal = input.goal ?? "leads";
  const contentType = mapContentStyleToContentType(profile.contentStyle);
  const templateType = profile.contentStyle as TemplateType;
  const tone =
    (input.brandTone?.trim() ||
      input.selectedDirection?.tone?.trim() ||
      "ישיר וברור");

  const decisionReason = `Built from business profile (${profile.marketCategory}, ${profile.contentStyle}, trust=${profile.trustLevel}, visual=${profile.visualStrength}) and goal/platform context.`;

  const businessFit = `קטגוריית שוק ${profile.marketCategory}, סגנון תוכן ${profile.contentStyle}, רמת אמון נדרשת ${profile.trustLevel}.`;

  let platformFit = "קצב ומבנה מותאמים לפלטפורמה הנבחרת.";
  if (input.selectedPlatform === "tiktok") {
    platformFit = "קצב מהיר יותר המותאם לטיקטוק.";
  } else if (input.selectedPlatform === "instagram") {
    platformFit = "קצב מאוזן לאינסטגרם.";
  } else if (input.selectedPlatform === "facebook") {
    platformFit = "קצב מתון יותר המותאם לפייסבוק.";
  }

  const decisionSummary = `video=${videoType} ${durationSeconds}s pace=${pace} cta=${ctaStyle}`;

  const decisionInsights: DecisionInsightsBundle = {
    decisionSummary,
    cards: [
      enforceBudget({
        decisionKey: "ctaStyle",
        value: ctaStyle,
        drivers: [...drivers.base, ...drivers.intent],
        rulesFired: rulesCta,
        confidence: intentResolved ? "high" : "medium",
      }),
      enforceBudget({
        decisionKey: "videoType",
        value: videoType,
        drivers: [...drivers.base, ...drivers.video],
        rulesFired: rulesVideo,
        confidence: rulesVideo.some((r) =>
          [
            "video.format_video_forces_full",
            "video.pain_longform_escalation",
            "video.explanation_short_to_mid",
          ].includes(r)
        )
          ? "high"
          : "medium",
      }),
      enforceBudget({
        decisionKey: "durationSeconds",
        value: durationSeconds,
        drivers: [...drivers.base, ...drivers.video],
        rulesFired: rulesVideo,
        confidence: rulesVideo.includes("video.reel_caps_full_duration")
          ? "high"
          : "medium",
      }),
    ].slice(0, 3),
  };

  return {
    primaryGoal,
    contentType,
    videoType,
    structure,
    hookStyle,
    pace,
    targetDurationSeconds: durationSeconds,
    tone,
    ctaType: ctaStyle,
    templateType,
    visualMode: visualStrengthToMode(profile.visualStrength),
    decisionReason,
    businessFit,
    platformFit,
    legacyMapping,
    decisionInsights,
  };
}
