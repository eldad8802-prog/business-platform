import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { ContentDecision } from "@/lib/features/content/decision";
import type {
  EmotionalStage,
  InterruptionStyle,
  PacingCurve,
} from "../types";

// ─── Emotional Arc ────────────────────────────────────────────────────────────

function buildShortArc(profile: BusinessContentProfile): EmotionalStage[] {
  // 15s arc: interrupt → curiosity/pain → revelation → action
  const usesPain =
    profile.emotionalDriver === "pain" ||
    profile.emotionalDriver === "security";

  return [
    {
      startSecond: 0,
      endSecond: 2,
      emotion: "interruption",
      intensity: "high",
      note: "עצור את הגלילה — שניות 0–2 הן הכל",
    },
    {
      startSecond: 2,
      endSecond: 5,
      emotion: usesPain ? "pain" : "curiosity",
      intensity: "high",
      note: usesPain
        ? "שקף את הכאב — הצופה צריך להרגיש שמדברים עליו"
        : "פתח עניין — הצופה מתחיל לשאול 'מה זה?'",
    },
    {
      startSecond: 5,
      endSecond: 11,
      emotion: "revelation",
      intensity: "medium",
      note: "הגע לנקודה מהר — הפתרון או ההבדל חייב להיות ברור",
    },
    {
      startSecond: 11,
      endSecond: 14,
      emotion: "desire",
      intensity: "high",
      note: "גרום לצופה לרצות — ויזואל, תוצאה, או הבטחה",
    },
    {
      startSecond: 14,
      endSecond: 15,
      emotion: "action",
      intensity: "high",
      note: "CTA חדה וברורה — פעולה אחת בלבד",
    },
  ];
}

function buildMidArc(profile: BusinessContentProfile): EmotionalStage[] {
  // 28s arc: interrupt → curiosity → identification → revelation → trust → action
  const usesPain =
    profile.emotionalDriver === "pain" ||
    profile.emotionalDriver === "security";
  const needsProof = profile.trustLevel === "high" || profile.salesCycle === "long";

  return [
    {
      startSecond: 0,
      endSecond: 2,
      emotion: "interruption",
      intensity: "high",
      note: "עצור את הגלילה — שניות 0–2 הן הכל",
    },
    {
      startSecond: 2,
      endSecond: 5,
      emotion: "curiosity",
      intensity: "high",
      note: "פתח שאלה שהצופה לא יכול להתעלם ממנה",
    },
    {
      startSecond: 5,
      endSecond: 10,
      emotion: usesPain ? "pain" : "identification",
      intensity: "medium",
      note: usesPain
        ? "הגבר את הכאב — הצופה מרגיש שמישהו מבין אותו"
        : "גרום לזיהוי — 'זה בדיוק אני'",
    },
    {
      startSecond: 10,
      endSecond: 18,
      emotion: "revelation",
      intensity: "medium",
      note: "הצג את הפתרון, ההבדל, או הדרך — ברור ומוחשי",
    },
    {
      startSecond: 18,
      endSecond: 24,
      emotion: needsProof ? "proof" : "desire",
      intensity: "medium",
      note: needsProof
        ? "בנה אמינות — תוצאה, עדות, מספר, הוכחה"
        : "גרום לרצון — הצג את התמונה של החיים אחרי",
    },
    {
      startSecond: 24,
      endSecond: 26,
      emotion: "trust",
      intensity: "medium",
      note: "אמון אחרון לפני הקריאה לפעולה",
    },
    {
      startSecond: 26,
      endSecond: 28,
      emotion: "action",
      intensity: "high",
      note: "CTA ברורה — פעולה אחת, ניסוח ישיר",
    },
  ];
}

function buildFullArc(profile: BusinessContentProfile): EmotionalStage[] {
  // 42s arc: interrupt → curiosity → pain/identification → revelation → proof → desire → trust/urgency → action
  const usesPain =
    profile.emotionalDriver === "pain" ||
    profile.emotionalDriver === "security";

  return [
    {
      startSecond: 0,
      endSecond: 2,
      emotion: "interruption",
      intensity: "high",
      note: "עצור את הגלילה — שניות 0–2 הן הכל",
    },
    {
      startSecond: 2,
      endSecond: 6,
      emotion: "curiosity",
      intensity: "high",
      note: "פתח שאלה עמוקה או טענה שיוצרת מתח",
    },
    {
      startSecond: 6,
      endSecond: 12,
      emotion: usesPain ? "pain" : "identification",
      intensity: "medium",
      note: usesPain
        ? "הגבר את הבעיה — תיאור ספציפי שמרגיש אמיתי"
        : "זיהוי עמוק — הצופה חייב להרגיש 'זה אני'",
    },
    {
      startSecond: 12,
      endSecond: 22,
      emotion: "revelation",
      intensity: "medium",
      note: "הצג את הדרך — שלבים, הבדל, פתרון, או הסבר",
    },
    {
      startSecond: 22,
      endSecond: 32,
      emotion: "proof",
      intensity: "medium",
      note: "הוכחה מוחשית — עדות, מספרים, תוצאה, לפני-אחרי",
    },
    {
      startSecond: 32,
      endSecond: 36,
      emotion: "desire",
      intensity: "high",
      note: "גרום לצופה לרצות — הצג את החיים אחרי",
    },
    {
      startSecond: 36,
      endSecond: 39,
      emotion: "trust",
      intensity: "medium",
      note: "חיזוק אמון אחרון — אנחנו כאן, אנחנו בטוחים",
    },
    {
      startSecond: 39,
      endSecond: 41,
      emotion: "urgency",
      intensity: "high",
      note: "דחיפות אחרונה — למה עכשיו ולא מחר",
    },
    {
      startSecond: 41,
      endSecond: 42,
      emotion: "action",
      intensity: "high",
      note: "CTA אחת, ברורה, ישירה",
    },
  ];
}

export function resolveEmotionalArc(
  profile: BusinessContentProfile,
  decision: ContentDecision
): EmotionalStage[] {
  const videoType = decision.legacyMapping.videoType;

  switch (videoType) {
    case "SHORT": return buildShortArc(profile);
    case "MID":   return buildMidArc(profile);
    case "FULL":  return buildFullArc(profile);
    default:      return buildMidArc(profile);
  }
}

// ─── Interruption Style ───────────────────────────────────────────────────────

export function resolveInterruptionStyle(
  profile: BusinessContentProfile,
  decision: ContentDecision
): InterruptionStyle {
  const hookStyle = decision.legacyMapping.hookStyle;
  const { brandPersona, emotionalDriver } = profile;

  // TikTok-energy + energetic brand → visual shock first
  if (brandPersona === "energetic" && hookStyle === "pattern_break") {
    return "visual_shock";
  }

  // Pain-first → verbal hook that lands like a gut punch
  if (hookStyle === "pain_first" || emotionalDriver === "pain") {
    return "verbal_hook";
  }

  // Trust-first or result-first → open with a relatable question
  if (hookStyle === "trust_first") return "question";

  // Offer-first or pattern break → bold claim that creates cognitive dissonance
  if (hookStyle === "offer_first" || hookStyle === "pattern_break") {
    return "bold_claim";
  }

  // Professional brands → verbal hook is safer and more credible
  if (brandPersona === "professional" || brandPersona === "luxury") {
    return "verbal_hook";
  }

  return "verbal_hook";
}

// ─── Pacing Curve ─────────────────────────────────────────────────────────────

export function resolvePacingCurve(
  profile: BusinessContentProfile,
  decision: ContentDecision
): PacingCurve {
  const pace = decision.legacyMapping.pace;
  const { brandPersona, contentStyle, salesCycle } = profile;

  // Luxury → slow build before the payoff
  if (brandPersona === "luxury") return "slow_then_fast";

  // Transformation content → hook fast, slow down on the result to let it land
  if (contentStyle === "transformation") return "fast_then_slow";

  // Instant sales cycle → constant energy, no room for breathing
  if (salesCycle === "instant") return "fast_throughout";

  // Energetic brand or fast decision from tree → fast throughout
  if (brandPersona === "energetic" && pace === "fast") return "fast_throughout";

  // Professional / authority / explanation → steady rhythm builds credibility
  if (
    brandPersona === "professional" ||
    contentStyle === "authority" ||
    contentStyle === "explanation"
  ) {
    return "steady";
  }

  // Fallback based on pace from decision engine
  if (pace === "fast") return "fast_throughout";
  if (pace === "slow") return "slow_then_fast";
  return "steady";
}
