import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";

export type LLMPromptContext = {
  businessLabel: string;
  audienceLabel: string;
  mainOfferLabel: string;
  differentiatorLabel: string;
  goalLabel: string;
  contentGoalPrompt?: string;
  directionTitle?: string;
  directionDescription?: string;
  businessCategory?: string;
};

export type LLMPromptPlan = {
  platform: string;
  videoType: string;
  structure: string[];
};

export type LLMPrompt = {
  system: string;
  user: string;
};

const STRUCTURE_LABELS: Record<string, string> = {
  hook:        "פתיחה",
  pain:        "כאב / בעיה",
  context:     "הקשר",
  explanation: "הסבר",
  solution:    "פתרון",
  proof:       "הוכחה",
  result:      "תוצאה",
  offer:       "הצעה",
  trust:       "אמון",
  value:       "ערך",
  cta:         "קריאה לפעולה",
};

function formatStructure(parts: string[]): string {
  return parts
    .map((p, i) => `  ${i + 1}. ${STRUCTURE_LABELS[p] ?? p}`)
    .join("\n");
}

function formatEmotionalArc(blueprint: CreativeBlueprint): string {
  if (!blueprint.emotional_arc.length) return "";
  const labels = blueprint.emotional_arc.map((s) => s.emotion);
  return `emotional_arc: ${labels.join(" → ")}`;
}

export function buildLLMPrompt(
  blueprint: CreativeBlueprint,
  context: LLMPromptContext,
  plan: LLMPromptPlan
): LLMPrompt {
  const pb = blueprint.platform_behavior;

  const system = `אתה מנהל קריאייטיב AI. תפקידך לבצע CreativeBlueprint מדויק — לא להמציא חופשי, לבצע.
פלט: JSON בלבד. ללא markdown, ללא הסברים. רק אובייקט JSON תקין.`;

  const parts: string[] = [];

  // ─── Domain anchor — FIRST THING, anchors everything that follows ──────────
  // Placed before Blueprint so the LLM's first mental model is the specific topic.
  const anchorLines: string[] = [
    `# נושא הסרטון`,
    `הסרטון הוא על: ${context.mainOfferLabel} של ${context.businessLabel}`,
    `קהל היעד של הסרטון: ${context.audienceLabel}`,
    `הסרטון פונה אל ${context.audienceLabel} — לא אל בעל העסק.`,
  ];
  if (context.contentGoalPrompt) {
    anchorLines.push(``, `דרישת בעל העסק לסרטון (חובה לבצע): ${context.contentGoalPrompt}`);
  }
  if (context.directionTitle) {
    anchorLines.push(`כיוון שנבחר: ${context.directionTitle}`);
    if (context.directionDescription) {
      anchorLines.push(`פירוט: ${context.directionDescription}`);
    }
  }
  parts.push(anchorLines.join("\n"));

  // ─── Blueprint ─────────────────────────────────────────────────────────────
  const arcLine = formatEmotionalArc(blueprint);
  parts.push(`# CreativeBlueprint
storytelling_model:  ${blueprint.storytelling_model}
attention_strategy:  ${blueprint.attention_strategy}
interruption_style:  ${blueprint.interruption_style}
pacing_curve:        ${blueprint.pacing_curve}
narration_tone:      ${blueprint.narration_tone}
narration_strategy:  ${blueprint.narration_strategy}
visual_strategy:     ${blueprint.visual_strategy}
visual_energy:       ${blueprint.visual_energy}
cta_psychology:      ${blueprint.cta_psychology}
subtitle_behavior:   ${blueprint.subtitle_behavior}${arcLine ? `\n${arcLine}` : ""}
platform_behavior:   hook=${pb.hookWindowSeconds}s | caption=${pb.captionStrategy} | hashtags=${pb.hashtagCount}
reasoning:           ${blueprint.blueprint_reasoning}`);

  // ─── Business context ──────────────────────────────────────────────────────
  parts.push(`# פרופיל עסקי
עסק:          ${context.businessLabel}
הצעת ערך:     ${context.mainOfferLabel}
קהל:          ${context.audienceLabel}
מטרה:         ${context.goalLabel}
יתרון ייחודי: ${context.differentiatorLabel}`);

  // ─── Task ──────────────────────────────────────────────────────────────────
  // contentGoalPrompt and direction are already at top — not repeated here.
  parts.push(`# משימה
פלטפורמה: ${plan.platform} | סוג סרטון: ${plan.videoType}
מבנה — ${plan.structure.length} שוטים בדיוק:
${formatStructure(plan.structure)}`);

  // ─── Rules ─────────────────────────────────────────────────────────────────
  parts.push(`# חוקי ביצוע

## עוגן תוכן — חובה
- הסרטון פונה לקהל: ${context.audienceLabel}. הוא מדבר אל הלקוחות, לא אל בעל העסק.
- כל hook, shot, voice ו-CTA חייבים להתייחס ישירות ל-${context.mainOfferLabel}.
- אסור לייצר תוכן כללי על: שיווק, צמיחה עסקית, הגדלת פניות, גרפי ביצועים, החלטות פיניסיות — אלא אם ${context.mainOfferLabel} הוא בפועל תחום פיננסי/שיווקי.
- visual: תאר מה רואים בפועל בתחום ${context.mainOfferLabel} — לא גרפים עסקיים כלליים, לא "ירידה בפניות" אלא אם זה קשור ישירות לתחום.
- אם העסק הוא B2C (קוסמטיקה, אופנה, מסעדה, עיצוב, טיפולים, שירות מקומי, בנייה, רפואה) — אסור שפת B2B. אסור אנימציות גרפי עסקים, דשבורדים, "להגדיל פניות".

## שפה וסגנון
- הכל בעברית — אסור אנגלית בטקסט
- hook: 1-2 משפטים, חד, לא גנרי — מיישם interruption_style: ${blueprint.interruption_style}
- shots: בדיוק ${plan.structure.length} שוטים לפי המבנה לעיל
- visual: משפט אחד — מה שרואים / מצלמים ב-${context.mainOfferLabel}
- voice: 1-2 משפטים — עברית טבעית, לא שיווקית, לא גנרית
- caption: ${pb.captionStrategy} style + ${pb.hashtagCount} האשטגים, עד 130 תווים
- cta: משפט אחד פעיל, מיישם cta_psychology: ${blueprint.cta_psychology}
- אסור: "רוב האנשים", "אם גם אתם", "ככה זה נראה", "יש דרך", "זה ההבדל"
- הטון חייב להתאים ל-narration_tone: ${blueprint.narration_tone}`);

  // ─── Output schema ─────────────────────────────────────────────────────────
  parts.push(`# פורמט הפלט (JSON בלבד)
{
  "hook": "...",
  "shots": [
    {"visual": "...", "voice": "..."}
  ],
  "caption": "...",
  "cta": "..."
}`);

  return {
    system,
    user: parts.join("\n\n"),
  };
}
