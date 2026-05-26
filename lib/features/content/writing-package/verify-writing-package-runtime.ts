/**
 * Local smoke check: same log prefix/shape as `content-llm.service.ts`,
 * without OpenAI or Next.js. Run: `npx tsx lib/features/content/writing-package/verify-writing-package-runtime.ts`
 */
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { LLMPromptContext, LLMPromptPlan } from "@/lib/features/content/llm/llm-prompt-builder";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";
import {
  buildContentWritingPackage,
  toLLMChatPrompt,
} from "@/lib/features/content/writing-package";

const minimalBlueprint: CreativeBlueprint = {
  visual_strategy: "local_authentic",
  visual_energy: "medium",
  visual_identity: {
    colorMood: "neutral",
    lightingStyle: "natural",
    compositionStyle: "intimate",
  },
  narration_strategy: "on_camera",
  narration_tone: "warm",
  soundtrack_strategy: "subtle",
  soundtrack_genre: "local",
  storytelling_model: "local_trust",
  attention_strategy: "pattern_break",
  emotional_arc: [
    {
      startSecond: 0,
      endSecond: 3,
      emotion: "interruption",
      intensity: "high",
      note: "stop",
    },
  ],
  interruption_style: "verbal_hook",
  pacing_curve: "fast_then_slow",
  subtitle_behavior: "key_moments",
  cta_psychology: "trust",
  platform_behavior: {
    hookWindowSeconds: 2,
    captionStrategy: "short_punch",
    hashtagCount: 3,
    orientationNote: "9:16",
  },
  blueprint_reasoning: "verify-runtime fixture",
  confidence: "medium",
};

const baseContext: LLMPromptContext = {
  businessLabel: "בדיקה בע״מ",
  audienceLabel: "לקוחות פוטנציאליים",
  mainOfferLabel: "שירות בדיקה לדוגמה ארוכה מספיק",
  differentiatorLabel: "יחס אישי",
  goalLabel: "יותר אמון",
  contentGoalPrompt: "אני רוצה לקדם: שירות בדיקה לדוגמה ארוכה מספיק. מה שבדרך כלל עוצר אנשים: חושבים שזה מסובך מדי.",
  directionTitle: "כיוון בדיקה",
  directionDescription: "תיאור קצר לכיוון",
  directionWhyItFits: "מתאים לקהל",
  businessCategory: "שירותים",
  archetypeBehaviorBrief: "ארכיטיפ בדיקה: טון רגוע, בלי לחץ.",
};

const plan: LLMPromptPlan = {
  platform: "instagram",
  videoType: "SHORT",
  structure: ["hook", "value", "cta"],
};

const sampleInsights: ContentInsightAnswer[] = [
  {
    questionFamily: "misconception",
    questionVariantId: "video.trust:misconception:f0",
    text: "אנשים חושבים שזה תמיד לוקח חודש — ובפועל זה שבוע.",
    chipsUsed: ["זמן"],
    recordedAtIso: "2026-05-15T12:00:00.000Z",
  },
];

function logSectionsLine(pkg: ReturnType<typeof buildContentWritingPackage>) {
  console.info(
    `[writing-package] sections=${pkg.sections.map((s) => s.id).join(",")}`
  );
}

function main() {
  const withoutInsights = buildContentWritingPackage({
    blueprint: minimalBlueprint,
    context: baseContext,
    plan,
    llmPromptStyle: "full",
    contentArchetypeId: "video.trust",
  });
  logSectionsLine(withoutInsights);

  const withInsights = buildContentWritingPackage({
    blueprint: minimalBlueprint,
    context: baseContext,
    plan,
    llmPromptStyle: "full",
    contentInsightAnswers: sampleInsights,
    contentArchetypeId: "video.trust",
  });
  logSectionsLine(withInsights);

  const hi = withInsights.sections.find((s) => s.id === "user.human_insights");
  if (!hi?.body.includes("חומר הבנה")) {
    throw new Error("expected human_insights section to carry non-copy guidance");
  }
  if (!hi.body.includes("misconception")) {
    throw new Error("expected human_insights body to reference answer family");
  }

  const prompt = toLLMChatPrompt(withInsights);
  if (!prompt.system.trim() || !prompt.user.trim()) {
    throw new Error("toLLMChatPrompt should delegate to non-empty legacy prompt");
  }

  console.info("[verify-writing-package] OK (package + delegate prompt)");
}

main();
