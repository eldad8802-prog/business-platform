import type { FunnelStage, GoalType, IntentType } from "./interpretation.service";
import type { Strategy } from "../strategy-engine.service";

type DistributionInput = {
  goal: GoalType;
  intent: IntentType;
  stage: FunnelStage;
  selectedFormat?: "reel" | "video" | "image" | "post";
  variantId: "desire" | "trust" | "result";
  forcedStrategyType?: Strategy["type"];
};

export type DistributionPlan = {
  primaryGoal: "retention" | "comments" | "shares" | "saves";
  triggerType: "curiosity" | "conversation" | "value" | "emotion" | "proof";
  ctaApproach: "soft" | "mid" | "hard";
  ctaText: string;
  pacingHint: string;
  packagingHint: string;
  retentionHint: string;
};

function applyDistributionOverrides(
  plan: DistributionPlan,
  forcedStrategyType?: Strategy["type"]
): DistributionPlan {
  if (!forcedStrategyType) {
    return plan;
  }

  if (forcedStrategyType === "direct_result") {
    return {
      ...plan,
      primaryGoal: "comments",
      triggerType: "proof",
      ctaApproach: "hard",
      ctaText: "שלחו הודעה עכשיו",
      pacingHint: "קצב מהיר, ישיר, עם payoff ברור ובלי פתיחה חלשה",
      packagingHint: "כיתוב חד שמבהיר מהר מה יוצא ללקוח מזה",
      retentionHint: "להראות תוצאה או הבטחה ברורה כבר בהתחלה",
    };
  }

  if (forcedStrategyType === "problem_solution") {
    return {
      ...plan,
      primaryGoal: "comments",
      triggerType: "conversation",
      ctaApproach: "mid",
      ctaText: "שלחו הודעה",
      pacingHint: "מבנה ברור של כאב → פתרון → פעולה, בלי להסתבך",
      packagingHint: "כיתוב פשוט, נגיש ומזמין תגובה או פנייה",
      retentionHint: "לפתוח עם כאב ברור או טעות נפוצה ולנוע מהר לפתרון",
    };
  }

  if (forcedStrategyType === "authority") {
    return {
      ...plan,
      primaryGoal: "saves",
      triggerType: "value",
      ctaApproach: "soft",
      ctaText: "תשמרו את זה",
      pacingHint: "קצב מקצועי, יציב וברור שנותן תחושת שליטה",
      packagingHint: "כיתוב מסודר עם ערך או תובנה ברורה",
      retentionHint: "להכניס הוכחה מקצועית או שלב חשוב כבר בתחילת התוכן",
    };
  }

  if (forcedStrategyType === "pattern_break") {
    return {
      ...plan,
      primaryGoal: "shares",
      triggerType: "emotion",
      ctaApproach: "soft",
      ctaText: "תמשיכו לראות",
      pacingHint: "קצב חד ודינמי עם כניסה חזקה כבר מהשנייה הראשונה",
      packagingHint: "כיתוב קצר ובולט שתופס עין מהר",
      retentionHint: "הוק חד מאוד בשוט הראשון או בשורה הראשונה",
    };
  }

  if (forcedStrategyType === "contrast") {
    return {
      ...plan,
      primaryGoal: "shares",
      triggerType: "proof",
      ctaApproach: "mid",
      ctaText: "תראו את ההבדל",
      pacingHint: "קצב חד שמדגיש פער, השוואה או טעות בצורה ברורה",
      packagingHint: "כיתוב שמחדד מה לא נכון ומה כן נכון",
      retentionHint: "להציג את ההבדל מהר ולא להסתיר את הנקודה",
    };
  }

  if (forcedStrategyType === "proof") {
    return {
      ...plan,
      primaryGoal: "saves",
      triggerType: "proof",
      ctaApproach: "mid",
      ctaText: "תשמרו את זה",
      pacingHint: "קצב ברור עם חיזוק דרך הוכחה, תהליך או תוצאה",
      packagingHint: "כיתוב שמראה שיש כאן בסיס אמיתי ולא רק דיבורים",
      retentionHint: "להכניס proof כמה שיותר מוקדם",
    };
  }

  if (forcedStrategyType === "emotional") {
    return {
      ...plan,
      primaryGoal: "shares",
      triggerType: "emotion",
      ctaApproach: "soft",
      ctaText: "אם זה דיבר אליכם — תשתפו",
      pacingHint: "קצב טבעי יותר, עם מקום לרגש ולעיבוד",
      packagingHint: "כיתוב פחות מכירתי ויותר אנושי",
      retentionHint: "לפתוח ברגע שמעורר הזדהות או תחושה",
    };
  }

  return plan;
}

export function buildDistributionPlan(
  input: DistributionInput
): DistributionPlan {
  const format = input.selectedFormat || "reel";
  let basePlan: DistributionPlan;

  if (input.variantId === "trust" || input.goal === "trust") {
    basePlan = {
      primaryGoal: "saves",
      triggerType: "value",
      ctaApproach: "soft",
      ctaText: input.intent === "follow" ? "עקבו לעוד" : "תשמרו את זה",
      pacingHint:
        format === "image" || format === "post"
          ? "קצב נקי וברור, בלי עומס, עם מסר אחד"
          : "קצב יציב, נקי ומקצועי, בלי דרמה מזויפת",
      packagingHint: "כיתוב נקי שנותן ערך או תובנה ברורה",
      retentionHint: "להכניס הוכחה או שלב מקצועי כבר בתחילת התוכן",
    };

    return applyDistributionOverrides(basePlan, input.forcedStrategyType);
  }

  if (
    input.variantId === "result" ||
    input.goal === "sales" ||
    input.intent === "sale"
  ) {
    basePlan = {
      primaryGoal: "comments",
      triggerType: "proof",
      ctaApproach: "hard",
      ctaText:
        input.intent === "sale" ? "הזמינו עכשיו" : "שלחו הודעה עכשיו",
      pacingHint:
        format === "image" || format === "post"
          ? "מסר חד וישיר עם תוצאה ברורה בלי סיבובים"
          : "קצב מהיר, ישיר, עם תוצאה ברורה ובלי פתיחה איטית",
      packagingHint: "כיתוב חד שמבהיר מה יוצא ללקוח מזה",
      retentionHint: "להראות תוצאה או payoff מהר מאוד",
    };

    return applyDistributionOverrides(basePlan, input.forcedStrategyType);
  }

  if (input.goal === "leads" || input.intent === "message") {
    basePlan = {
      primaryGoal: "comments",
      triggerType: "conversation",
      ctaApproach: "mid",
      ctaText: "שלחו הודעה",
      pacingHint:
        format === "image" || format === "post"
          ? "מבנה קצר עם מסר מושך ואז הנעה ברורה"
          : "קצב מהיר, עם עצירת גלילה ואז מעבר מהיר לפעולה",
      packagingHint: "כיתוב קצר שמרגיש נגיש ומזמין שיחה",
      retentionHint: "לפתוח עם רגע שמושך תשומת לב ואז להוביל מהר לפעולה",
    };

    return applyDistributionOverrides(basePlan, input.forcedStrategyType);
  }

  if (input.stage === "TOFU") {
    basePlan = {
      primaryGoal: "shares",
      triggerType: "emotion",
      ctaApproach: "soft",
      ctaText: "תמשיכו לראות",
      pacingHint:
        format === "image" || format === "post"
          ? "מסר קליט, קצר וקל לשיתוף"
          : "קצב דינמי עם סקרנות, תנועה ושבירת גלילה",
      packagingHint: "כיתוב קצר שתופס עין ושווה לשתף",
      retentionHint: "חייב להיות hook חד בשורה הראשונה או בשוט הראשון",
    };

    return applyDistributionOverrides(basePlan, input.forcedStrategyType);
  }

  basePlan = {
    primaryGoal: "retention",
    triggerType: "curiosity",
    ctaApproach: "soft",
    ctaText: "תמשיכו לראות",
    pacingHint:
      format === "image" || format === "post"
        ? "מסר חד, קצר, קל לעיכול"
        : "קצב חברתי טבעי, בלי פתיחה איטית ובלי חפירות",
    packagingHint: "כיתוב קצר, חי, ולא תבניתי",
    retentionHint: "להכניס סקרנות או מתח כבר בתחילת התוכן",
  };

  return applyDistributionOverrides(basePlan, input.forcedStrategyType);
}