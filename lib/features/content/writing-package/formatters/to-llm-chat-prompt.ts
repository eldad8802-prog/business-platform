import type { ContentWritingPackage, LLMChatPrompt } from "../types";
import { buildLLMPrompt } from "@/lib/features/content/llm/llm-prompt-builder";
import { buildCompactPrompt } from "@/lib/features/content/llm/llm-prompt-compact";

/**
 * Phase-1: delegates to existing prompt builders so runtime stays equivalent.
 * The structured `package.sections` are not concatenated here yet — they exist
 * for architecture, logs, and future formatters.
 */
export function toLLMChatPrompt(pkg: ContentWritingPackage): LLMChatPrompt {
  const { blueprint, context, plan } = pkg.sources;
  switch (pkg.llmPromptStyle) {
    case "compact":
      return buildCompactPrompt(blueprint, context, plan, false);
    case "compact_fewshot":
      return buildCompactPrompt(blueprint, context, plan, true);
    case "full":
    default:
      return buildLLMPrompt(blueprint, context, plan);
  }
}
