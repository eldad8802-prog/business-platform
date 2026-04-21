import { generateScript } from "@/lib/services/ai-content.service";
import {
  getBusinessContentProfile,
  type BusinessContentProfile,
} from "@/lib/services/business-content-profile.service";

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

type VariantStyle = "direct" | "explanatory" | "trust";

type VideoPlanInput = {
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

  businessProfile?: BusinessContentProfile;

  videoType?: VideoType;
  durationSeconds?: number;
  structure?: string[];
  pace?: "fast" | "medium" | "slow";
  hookStyle?:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";
  ctaStyle?: "message_now" | "book_now" | "buy_now" | "follow" | "learn_more";
  decisionReasoning?: string;
};

type Shot = {
  visual: string;
  voice: string;
};

type Script = {
  title?: string;
  hook?: string;
  scriptText: string;
  caption: string;
  shots: Shot[];
};

type ShotRequest = {
  index: number;
  purpose: string;
  visualPrompt: string;
  shootingGuidance: string;
};

type AssetsPlan = {
  requiredAssets: string[];
  optionalAssets: string[];
};

type Variant = {
  id: string;
  title: string;
  description: string;
  whyItFits: string;
  score: number;
  tone: string;
  pace: string;
  videoType: VideoType;
  durationSeconds: number;
  structure: string[];
  script: Script;
  shotRequests: ShotRequest[];
  assetsPlan: AssetsPlan;
};

type VideoPlanResult = {
  variants: Variant[];
};

type ScriptVideoPlan = {
  videoType: VideoType;
  durationSeconds: number;
  pace: "fast" | "medium" | "slow";
  structure: string[];
  hookStyle:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";
  ctaStyle: "message_now" | "book_now" | "buy_now" | "follow" | "learn_more";
  platform: string;
  goal: string;
  contentAngle?: string;
};

function normalizeText(value?: string) {
  return (value || "").trim();
}

function getGoalLabel(goal?: Goal) {
  switch (goal) {
    case "leads":
      return "לייצר יותר פניות";
    case "trust":
      return "לבנות יותר אמון";
    case "exposure":
      return "להגדיל חשיפה";
    case "sales":
      return "להניע יותר מכירות";
    default:
      return "לקדם את העסק";
  }
}

function getAngleLabel(angle?: ContentAngle) {
  switch (angle) {
    case "show_result":
      return "להראות תוצאה";
    case "explain":
      return "להסביר משהו חשוב";
    case "show_difference":
      return "להראות את ההבדל";
    case "attention":
      return "לתפוס תשומת לב";
    case "trust":
      return "לחזק אמון";
    case "cta":
      return "להניע לפעולה";
    default:
      return "להעביר מסר ברור";
  }
}

function getVariantTone(
  businessProfile: BusinessContentProfile,
  style: VariantStyle
) {
  if (style === "trust") {
    if (
      businessProfile.brandPersona === "luxury" ||
      businessProfile.brandPersona === "premium"
    ) {
      return "בטוח, מדויק ויוקרתי";
    }

    if (businessProfile.brandPersona === "personal") {
      return "אישי, רגוע ומחבר";
    }

    return "בטוח, מקצועי ואמין";
  }

  if (style === "explanatory") {
    if (businessProfile.brandPersona === "energetic") {
      return "ברור, דינמי ובגובה העיניים";
    }

    return "ברור, מסודר ונגיש";
  }

  if (businessProfile.brandPersona === "energetic") {
    return "ישיר, חד ואנרגטי";
  }

  if (businessProfile.brandPersona === "friendly") {
    return "פשוט, נעים וקרוב";
  }

  return "ישיר וברור";
}

function getVariantPace(
  basePace: "fast" | "medium" | "slow" | undefined,
  style: VariantStyle
): "fast" | "medium" | "slow" {
  if (style === "direct") {
    if (basePace === "slow") return "medium";
    return basePace || "fast";
  }

  if (style === "explanatory") {
    if (basePace === "fast") return "medium";
    return basePace || "medium";
  }

  if (style === "trust") {
    if (basePace === "fast") return "medium";
    return basePace === "medium" ? "medium" : "slow";
  }

  return basePace || "medium";
}

function getVariantTitle(input: VideoPlanInput, style: VariantStyle) {
  const baseTitle = normalizeText(input.selectedDirection?.title) || "כיוון תוכן";

  if (style === "direct") {
    return `${baseTitle} — גרסה ישירה`;
  }

  if (style === "explanatory") {
    return `${baseTitle} — גרסה מסבירה`;
  }

  return `${baseTitle} — גרסה מחזקת אמון`;
}

function getVariantDescription(style: VariantStyle, input: VideoPlanInput) {
  const goalLabel = getGoalLabel(input.goal);

  if (style === "direct") {
    return `גרסה חדה יותר שמדגישה מסר ברור ומהיר כדי ${goalLabel}.`;
  }

  if (style === "explanatory") {
    return `גרסה שמסבירה יותר טוב את ההיגיון, הערך והדרך כדי ${goalLabel}.`;
  }

  return `גרסה שבונה יותר ביטחון, אמינות והרגשה נכונה כדי ${goalLabel}.`;
}

function getVariantWhyItFits(
  style: VariantStyle,
  input: VideoPlanInput,
  businessProfile: BusinessContentProfile
) {
  const goalLabel = getGoalLabel(input.goal);
  const angleLabel = getAngleLabel(input.contentAngle);

  if (style === "direct") {
    return `הגרסה הזאת מתאימה כשצריך לגרום לאנשים להבין מהר את המסר המרכזי ולהתקדם לכיוון של ${goalLabel}, במיוחד לעסק עם אופי ${businessProfile.brandPersona}.`;
  }

  if (style === "explanatory") {
    return `הגרסה הזאת מתאימה כשצריך להסביר טוב יותר את הערך, לתת הקשר ברור ולעזור לאנשים להבין למה זה רלוונטי עבורם דרך תוכן שיודע ${angleLabel}.`;
  }

  return `הגרסה הזאת מתאימה כשצריך לחזק אמון, להוריד התנגדות ולבנות תחושת ביטחון לפני פעולה, במיוחד בעסק שבו רמת האמון הנדרשת היא ${businessProfile.trustLevel}.`;
}

function getVariantScore(
  input: VideoPlanInput,
  style: VariantStyle,
  businessProfile: BusinessContentProfile
) {
  let base = 86;

  if (input.videoType === "FULL") base += 4;
  if (input.videoType === "MID") base += 2;

  if (style === "direct") base += 2;
  if (style === "trust" && businessProfile.trustLevel === "high") base += 4;
  if (style === "explanatory" && businessProfile.contentStyle === "explanation") {
    base += 4;
  }

  return Math.min(96, base);
}

function getStyleAdjustedHookStyle(
  baseHookStyle: VideoPlanInput["hookStyle"],
  style: VariantStyle,
  businessProfile: BusinessContentProfile
): NonNullable<VideoPlanInput["hookStyle"]> {
  if (style === "trust") {
    return "trust_first";
  }

  if (style === "direct") {
    if (businessProfile.hookPriority === "offer_first") {
      return "offer_first";
    }

    if (businessProfile.hookPriority === "result_first") {
      return "result_first";
    }

    return "pattern_break";
  }

  if (style === "explanatory") {
    if (businessProfile.hookPriority === "pain_first") {
      return "pain_first";
    }

    return "result_first";
  }

  return baseHookStyle || businessProfile.hookPriority;
}

function getStyleAdjustedCtaStyle(
  baseCtaStyle: VideoPlanInput["ctaStyle"],
  style: VariantStyle,
  businessProfile: BusinessContentProfile
): NonNullable<VideoPlanInput["ctaStyle"]> {
  if (style === "trust") {
    return businessProfile.trustLevel === "high" ? "learn_more" : "follow";
  }

  if (style === "direct") {
    if (businessProfile.offerType === "product") {
      return "buy_now";
    }

    return businessProfile.ctaStyle === "learn_more"
      ? "message_now"
      : businessProfile.ctaStyle;
  }

  if (style === "explanatory") {
    return businessProfile.offerType === "service" ? "message_now" : "learn_more";
  }

  return baseCtaStyle || businessProfile.ctaStyle;
}

function getStyleAdjustedContentAngle(
  originalAngle: ContentAngle | undefined,
  style: VariantStyle
): ContentAngle | undefined {
  if (style === "trust") return "trust";
  if (style === "direct") return "cta";
  if (style === "explanatory") return "explain";
  return originalAngle;
}

function getStyleAdjustedDuration(
  baseDuration: number | undefined,
  videoType: VideoType | undefined,
  style: VariantStyle
) {
  const fallback = videoType === "SHORT" ? 15 : videoType === "MID" ? 28 : 42;
  const duration = baseDuration || fallback;

  if (style === "direct") {
    return Math.max(12, duration - 4);
  }

  if (style === "explanatory") {
    return duration;
  }

  return duration + (videoType === "SHORT" ? 2 : 4);
}

function buildShotRequests(shots: Shot[], style: VariantStyle): ShotRequest[] {
  return shots.map((shot, index) => ({
    index,
    purpose: shot.voice,
    visualPrompt: shot.visual,
    shootingGuidance:
      index === 0
        ? style === "direct"
          ? "פתיחה מהירה, חדה ותופסת. להיכנס ישר לעניין בלי הקדמות."
          : style === "trust"
          ? "פתיחה בטוחה, רגועה ואמינה. מבט יציב ונוכחות נקייה."
          : "פתיחה ברורה שמכניסה מהר לנושא ונותנת הקשר."
        : index === shots.length - 1
        ? "שוט סיום נקי עם מקום ברור ל־CTA אחד בלבד."
        : style === "direct"
        ? "שוט קצר, חד, עם מסר אחד ברור בלי עומס."
        : style === "trust"
        ? "שוט יציב, אמין ולא לחוץ. לתת מקום למסר לנשום."
        : "שוט ברור שמסביר את הרעיון בצורה פשוטה.",
  }));
}

function buildAssetsPlan(
  input: VideoPlanInput,
  style: VariantStyle,
  businessProfile: BusinessContentProfile,
  shots: Shot[]
): AssetsPlan {
  const requiredAssets: string[] = [];
  const optionalAssets: string[] = [];

  if (input.mode === "camera" || input.mode === "voice") {
    requiredAssets.push("צילום אנכי 9:16");
    requiredAssets.push("שוט פתיחה חזק ל־Hook");
    requiredAssets.push("שוטי B-roll קצרים שתומכים במסר");
    requiredAssets.push("שוט סיום ברור ל־CTA");
  } else {
    requiredAssets.push("ויזואלים אנכיים שתומכים בכל שלב בתסריט");
    requiredAssets.push("תמונות או קטעי וידאו תואמים למסר הראשי");
  }

  if (businessProfile.visualStrength === "high") {
    requiredAssets.push("תוצאה ויזואלית ברורה או המחשה חזקה");
  }

  if (style === "trust" || businessProfile.trustLevel === "high") {
    optionalAssets.push("המלצה, חוות דעת או דוגמה אמיתית");
    optionalAssets.push("הוכחת תוצאה או תהליך אמין");
  }

  if (businessProfile.contentStyle === "transformation") {
    optionalAssets.push("Before / After");
  }

  if (shots.length >= 6) {
    optionalAssets.push("שוטי תמיכה נוספים להחזיק קצב לאורך הסרטון");
  }

  optionalAssets.push("לוגו לשימוש רק בסיום אם צריך");
  optionalAssets.push("צילום מקום / תהליך / שירות / מוצר");

  return {
    requiredAssets,
    optionalAssets,
  };
}

function getResolvedBusinessProfile(input: VideoPlanInput): BusinessContentProfile {
  if (input.businessProfile) {
    return input.businessProfile;
  }

  return getBusinessContentProfile({
    businessType: input.businessType,
    businessCategory: input.businessCategory,
    businessName: input.businessName,
    services: input.services,
    products: input.products,
    targetAudience: input.audienceTypes,
    brandTone: input.brandTone ?? input.selectedDirection?.tone,
    primaryGoal: input.goal,
    priceLevel: input.priceLevel,
    differentiators: input.differentiators,
  });
}

async function buildVariant(
  input: VideoPlanInput,
  style: VariantStyle,
  index: number,
  businessProfile: BusinessContentProfile
): Promise<Variant> {
  const resolvedVideoType: VideoType =
    input.videoType || businessProfile.recommendedVideoType;

  const resolvedDuration = getStyleAdjustedDuration(
    input.durationSeconds,
    resolvedVideoType,
    style
  );

  const resolvedPace = getVariantPace(input.pace, style);
  const resolvedStructure = input.structure || ["hook", "value", "cta"];
  const resolvedHookStyle = getStyleAdjustedHookStyle(
    input.hookStyle,
    style,
    businessProfile
  );
  const resolvedCtaStyle = getStyleAdjustedCtaStyle(
    input.ctaStyle,
    style,
    businessProfile
  );
  const resolvedPlatform = input.selectedPlatform || "instagram";
  const resolvedGoal = input.goal || "leads";
  const resolvedContentAngle = getStyleAdjustedContentAngle(
    input.contentAngle,
    style
  );

  const videoPlan: ScriptVideoPlan = {
    videoType: resolvedVideoType,
    durationSeconds: resolvedDuration,
    pace: resolvedPace,
    structure: resolvedStructure,
    hookStyle: resolvedHookStyle,
    ctaStyle: resolvedCtaStyle,
    platform: resolvedPlatform,
    goal: resolvedGoal,
    contentAngle: resolvedContentAngle,
  };

  const generated = await generateScript({
    businessType: input.businessType,
    businessCategory: input.businessCategory,
    businessName: input.businessName,
    goal: input.goal,
    contentAngle: resolvedContentAngle,
    audience: input.audienceTypes,
    services: input.services,
    products: input.products,
    brandTone: input.brandTone ?? input.selectedDirection?.tone,
    priceLevel: input.priceLevel,
    differentiators: input.differentiators,
    videoPlan,
  });

  const shots = generated.shots || [];
  const title = getVariantTitle(input, style);

  return {
    id: `variant_${style}_${index + 1}`,
    title,
    description: getVariantDescription(style, input),
    whyItFits: getVariantWhyItFits(style, input, businessProfile),
    score: getVariantScore(input, style, businessProfile),
    tone: getVariantTone(businessProfile, style),
    pace: videoPlan.pace,
    videoType: videoPlan.videoType,
    durationSeconds: videoPlan.durationSeconds,
    structure: videoPlan.structure,
    script: {
      title,
      hook: generated.hook,
      scriptText: generated.scriptText,
      caption: generated.caption,
      shots,
    },
    shotRequests: buildShotRequests(shots, style),
    assetsPlan: buildAssetsPlan(input, style, businessProfile, shots),
  };
}

export async function buildVideoPlan(
  input: VideoPlanInput
): Promise<VideoPlanResult> {
  const businessProfile = getResolvedBusinessProfile(input);

  const normalizedInput: VideoPlanInput = {
    ...input,
    selectedFormat:
      input.selectedFormat || input.selectedDirection?.recommendedFormat || "reel",
    selectedPlatform: input.selectedPlatform || "instagram",
    videoType: input.videoType || businessProfile.recommendedVideoType,
    durationSeconds:
      input.durationSeconds ||
      (businessProfile.recommendedVideoType === "SHORT"
        ? 15
        : businessProfile.recommendedVideoType === "MID"
        ? 28
        : 42),
    structure: input.structure || ["hook", "value", "cta"],
    businessProfile,
  };

  const variants = await Promise.all([
    buildVariant(normalizedInput, "direct", 0, businessProfile),
    buildVariant(normalizedInput, "explanatory", 1, businessProfile),
    buildVariant(normalizedInput, "trust", 2, businessProfile),
  ]);

  return {
    variants,
  };
}