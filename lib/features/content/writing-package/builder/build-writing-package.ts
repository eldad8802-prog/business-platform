import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type {
  ContentInsightAnswer,
} from "@/lib/features/content/question-engine/types";
import type {
  ContentWritingPackage,
  ContentWritingPackageBuildInput,
  WritingPackageSection,
} from "../types";

function safeTrim(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function formatBlueprintSummary(blueprint: CreativeBlueprint): string {
  const arc =
    blueprint.emotional_arc?.length > 0
      ? blueprint.emotional_arc.map((x) => x.emotion).join(" → ")
      : "";
  const lines = [
    `storytelling_model: ${blueprint.storytelling_model}`,
    `attention_strategy: ${blueprint.attention_strategy}`,
    `interruption_style: ${blueprint.interruption_style}`,
    `pacing_curve: ${blueprint.pacing_curve}`,
    `narration_tone: ${blueprint.narration_tone}`,
    `narration_strategy: ${blueprint.narration_strategy}`,
    `visual_strategy: ${blueprint.visual_strategy}`,
    `visual_energy: ${blueprint.visual_energy}`,
    `cta_psychology: ${blueprint.cta_psychology}`,
    `subtitle_behavior: ${blueprint.subtitle_behavior}`,
  ];
  if (arc) lines.push(`emotional_arc: ${arc}`);
  return lines.join("\n");
}

function formatBusinessContextSummary(input: {
  businessLabel: string;
  audienceLabel: string;
  mainOfferLabel: string;
  differentiatorLabel: string;
  goalLabel: string;
  businessCategory?: string;
}): string {
  const parts = [
    `עסק: ${input.businessLabel}`,
    `קהל: ${input.audienceLabel}`,
    `הצעה מרכזית: ${input.mainOfferLabel}`,
    `מטרה: ${input.goalLabel}`,
    `יתרון: ${input.differentiatorLabel}`,
  ];
  if (input.businessCategory?.trim()) {
    parts.push(`קטגוריה: ${input.businessCategory.trim()}`);
  }
  return parts.join("\n");
}

function formatDirectionSummary(input: {
  title?: string;
  description?: string;
  whyItFits?: string;
}): string {
  const t = safeTrim(input.title);
  const d = safeTrim(input.description);
  const w = safeTrim(input.whyItFits);
  if (!t && !d && !w) return "";
  const lines: string[] = [];
  if (t) lines.push(`כותרת: ${t}`);
  if (d) lines.push(`תיאור: ${d}`);
  if (w) lines.push(`למה מתאים: ${w}`);
  return lines.join("\n");
}

function formatHumanInsightsSection(answers: ContentInsightAnswer[] | undefined): string {
  if (!answers?.length) {
    return "";
  }
  const header = [
    "חומר הבנה בלבד — לא לציטוט במילים של המשתמש.",
    "לא להפוך ל-hook ישיר, לא להדביק לתסריט כפי שנכתב.",
    "להשתמש רק כדי להעשיר POV, חיכוך, אמת אנושית, והקשר רגשי.",
    "---",
  ].join("\n");

  const blocks = answers.map((a, i) => {
    const chips =
      a.chipsUsed && a.chipsUsed.length > 0 ? ` [צ'יפים: ${a.chipsUsed.join(" · ")}]` : "";
    const text = safeTrim(a.text);
    const textNote = text ? `תשובה (לא לציטוט): ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}` : "תשובה: (ריק / צ'יפים בלבד)";
    return `(${i + 1}) משפחה=${a.questionFamily} variant=${a.questionVariantId}${chips}\n${textNote}`;
  });

  return `${header}\n${blocks.join("\n\n")}`;
}

function formatValidationRefs(input: {
  archetypeId?: string;
  platform: string;
  videoType: string;
}): string {
  const parts = [
    `archetypeId: ${input.archetypeId ?? "לא צוין"}`,
    `platform: ${input.platform}`,
    `videoType: ${input.videoType}`,
    "validationTarget: llm_script_json_v1",
  ];
  return parts.join("\n");
}

function formatCreativeEnvelope(): string {
  return [
    "חופש יצירתי: ניסוח מילולי, דימויים, מעברים — בתוך גבולות ה-Blueprint והארכיטיפ.",
    "רך: עדיף טבעי ושיחתי; קשה: לא להמציא עובדות עסקיות, לא לצטט brief/insights.",
  ].join("\n");
}

function formatOutputSchema(structureLength: number): string {
  return [
    "פלט: JSON בלבד (ללא markdown).",
    `מבנה shots: בדיוק ${structureLength} פריטים.`,
    "שדות: hook, shots[{visual,voice}], caption, cta",
  ].join("\n");
}

function formatSystemMandate(): string {
  return [
    "תפקיד המודל: כותב תוכן לרילים/ווידאו חברתי — לא דף נחיתה ולא מצגת מכירות.",
    "מקור האמת להתנהגות: CreativeBlueprint + כוונת ערוץ; המשתמש לא כותב את התסריט כאן.",
  ].join("\n");
}

/**
 * Builds the structured writing package for an LLM attempt.
 * Missing optional fields produce empty/minimal section bodies — never throws.
 */
export function buildContentWritingPackage(
  input: ContentWritingPackageBuildInput
): ContentWritingPackage {
  const {
    blueprint,
    context,
    plan,
    llmPromptStyle,
    contentInsightAnswers,
    contentArchetypeId,
  } = input;

  const structuredBrief = safeTrim(context.contentGoalPrompt);
  const archetypeBlock = safeTrim(context.archetypeBehaviorBrief);

  const sections: WritingPackageSection[] = [
    {
      id: "system.mandate",
      kind: "system",
      priority: 10,
      constraintLevel: "hard",
      body: formatSystemMandate(),
    },
    {
      id: "output.schema",
      kind: "schema",
      priority: 20,
      constraintLevel: "hard",
      body: formatOutputSchema(plan.structure.length),
    },
    {
      id: "intent.channel",
      kind: "context",
      priority: 30,
      constraintLevel: "hard",
      body: [
        `פלטפורמה: ${plan.platform}`,
        `סוג וידאו: ${plan.videoType}`,
        `מטרה (תווית): ${context.goalLabel}`,
        context.businessCategory?.trim()
          ? `קטגוריה עסקית: ${context.businessCategory.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      id: "archetype.contract",
      kind: "behavior",
      priority: 40,
      constraintLevel: "hard",
      body: archetypeBlock || "(לא הוגדר ארכיטיפ בקלט — אין חוזה התנהגות מפורש.)",
    },
    {
      id: "story.blueprint",
      kind: "behavior",
      priority: 50,
      constraintLevel: "hard",
      body: formatBlueprintSummary(blueprint),
    },
    {
      id: "business.context",
      kind: "context",
      priority: 60,
      constraintLevel: "soft",
      body: formatBusinessContextSummary({
        businessLabel: context.businessLabel,
        audienceLabel: context.audienceLabel,
        mainOfferLabel: context.mainOfferLabel,
        differentiatorLabel: context.differentiatorLabel,
        goalLabel: context.goalLabel,
        businessCategory: context.businessCategory,
      }),
    },
    {
      id: "user.structured_brief",
      kind: "context",
      priority: 70,
      constraintLevel: "soft",
      body:
        structuredBrief ||
        "(אין contentGoalPrompt מנורמל — עוגן היעד חסר או ריק.)",
    },
    {
      id: "user.human_insights",
      kind: "context",
      priority: 80,
      constraintLevel: "soft",
      body:
        formatHumanInsightsSection(contentInsightAnswers) ||
        "(אין contentInsightAnswers בקלט.)",
    },
    {
      id: "direction.summary",
      kind: "context",
      priority: 90,
      constraintLevel: "soft",
      body:
        formatDirectionSummary({
          title: context.directionTitle,
          description: context.directionDescription,
          whyItFits: context.directionWhyItFits,
        }) || "(אין כיוון נבחר בקלט.)",
    },
    {
      id: "creative.envelope",
      kind: "creative",
      priority: 100,
      constraintLevel: "soft",
      body: formatCreativeEnvelope(),
    },
    {
      id: "validation.refs",
      kind: "meta",
      priority: 110,
      constraintLevel: "none",
      body: formatValidationRefs({
        archetypeId: contentArchetypeId,
        platform: plan.platform,
        videoType: plan.videoType,
      }),
    },
  ];

  return {
    version: 1,
    llmPromptStyle,
    sections: [...sections].sort((a, b) => a.priority - b.priority),
    sources: { blueprint, context, plan },
  };
}
