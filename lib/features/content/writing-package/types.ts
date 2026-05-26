import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";
import type {
  LLMPromptContext,
  LLMPromptPlan,
} from "@/lib/features/content/llm/llm-prompt-builder";

/** Section taxonomy for the writing package (product + validation wiring). */
export type WritingPackageSectionKind =
  | "system"
  | "behavior"
  | "context"
  | "creative"
  | "schema"
  | "meta";

/** How strongly a section constrains the model (guidance vs contract). */
export type WritingPackageConstraintLevel = "hard" | "soft" | "none";

/** Stable section ids — used in logs and future validators. */
export type WritingPackageSectionId =
  | "system.mandate"
  | "output.schema"
  | "intent.channel"
  | "archetype.contract"
  | "story.blueprint"
  | "business.context"
  | "user.structured_brief"
  | "user.human_insights"
  | "direction.summary"
  | "creative.envelope"
  | "validation.refs";

export type WritingPackageSection = {
  id: WritingPackageSectionId;
  kind: WritingPackageSectionKind;
  /** Lower = earlier in product ordering (not necessarily prompt order in phase-1). */
  priority: number;
  constraintLevel: WritingPackageConstraintLevel;
  /** Section body for structure / future formatters; may be empty when unknown. */
  body: string;
};

/** Which legacy LLM prompt builder path to delegate to (phase-1: identical runtime). */
export type WritingPackageLlmPromptStyle =
  | "full"
  | "compact"
  | "compact_fewshot";

export type ContentWritingPackageBuildInput = {
  blueprint: CreativeBlueprint;
  context: LLMPromptContext;
  plan: LLMPromptPlan;
  llmPromptStyle: WritingPackageLlmPromptStyle;
  /** Optional — from `content_flow` when the client forwards it. */
  contentInsightAnswers?: ContentInsightAnswer[] | undefined;
  /** Optional — for validation refs / logs (not duplicated inside `LLMPromptContext` today). */
  contentArchetypeId?: string | undefined;
};

/**
 * Structured package assembled before every LLM attempt.
 * Phase-1: `sources` + `llmPromptStyle` drive `toLLMChatPrompt` delegation to existing builders.
 */
export type ContentWritingPackage = {
  version: 1;
  llmPromptStyle: WritingPackageLlmPromptStyle;
  sections: WritingPackageSection[];
  sources: {
    blueprint: CreativeBlueprint;
    context: LLMPromptContext;
    plan: LLMPromptPlan;
  };
};

/** Chat messages sent to the provider (matches existing `LLMPrompt` contract). */
export type LLMChatPrompt = {
  system: string;
  user: string;
};
