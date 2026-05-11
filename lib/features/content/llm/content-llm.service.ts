import OpenAI from "openai";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import {
  buildLLMPrompt,
  type LLMPromptContext,
  type LLMPromptPlan,
} from "./llm-prompt-builder";
import { buildCompactPrompt } from "./llm-prompt-compact";
import {
  validateLLMOutput,
  checkDomainRelevance,
  type LLMScriptOutput,
} from "./llm-output-validator";

export type { LLMScriptOutput };

export type LLMExecutionInput = {
  blueprint: CreativeBlueprint;
  context: LLMPromptContext;
  plan: LLMPromptPlan;
};

export type LLMVariant = "full" | "compact" | "compact_fewshot";

export function isLLMEnabled(): boolean {
  return (
    process.env.CONTENT_LLM_ENABLED === "true" &&
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.length > 10
  );
}

function getActiveModel(): string {
  const m = process.env.CONTENT_LLM_MODEL?.trim();
  return m && m.length > 3 ? m : "gpt-4.1-mini";
}

function getActiveVariant(): LLMVariant {
  const v = process.env.CONTENT_LLM_VARIANT?.trim();
  if (v === "compact" || v === "compact_fewshot" || v === "full") return v;
  return "full";
}

function safeParseLLMResponse(text: string): unknown {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function tryGenerateWithLLM(
  input: LLMExecutionInput
): Promise<LLMScriptOutput | null> {
  if (!isLLMEnabled()) return null;

  const { blueprint, context, plan } = input;
  const variant = getActiveVariant();
  const model   = getActiveModel();

  let prompt;
  if (variant === "compact") {
    prompt = buildCompactPrompt(blueprint, context, plan, false);
  } else if (variant === "compact_fewshot") {
    prompt = buildCompactPrompt(blueprint, context, plan, true);
  } else {
    prompt = buildLLMPrompt(blueprint, context, plan);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user",   content: prompt.user },
      ],
      temperature: 0.7,
      max_tokens: 1200,
    });

    const text = response.choices[0]?.message?.content ?? "";
    const raw  = safeParseLLMResponse(text);
    const validated = validateLLMOutput(raw, plan.structure.length);

    // Domain guard — positive relevance check
    if (!checkDomainRelevance(validated, context.mainOfferLabel)) {
      console.warn(
        `[content-llm] Domain guard failed (variant=${variant}, model=${model}, offer="${context.mainOfferLabel}") — falling back to templates`
      );
      return null;
    }

    return validated;
  } catch (err) {
    console.error(
      `[content-llm] Generation failed (variant=${variant}, model=${model}):`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
