import OpenAI from "openai";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { ContentInsightAnswer } from "@/lib/features/content/question-engine/types";
import type { LLMPromptContext, LLMPromptPlan } from "./llm-prompt-builder";
import {
  validateLLMOutput,
  checkDomainRelevance,
  LLMOutputValidationError,
  isNonSpecificMainOfferLabel,
  type LLMScriptOutput,
} from "./llm-output-validator";
import {
  buildContentWritingPackage,
  toLLMChatPrompt,
} from "@/lib/features/content/writing-package";

export type { LLMScriptOutput };

export type LLMExecutionInput = {
  blueprint: CreativeBlueprint;
  context: LLMPromptContext;
  plan: LLMPromptPlan;
  /** Optional — forwarded from `content_flow` when available. */
  contentInsightAnswers?: ContentInsightAnswer[];
  /** Optional — for package validation refs / future wiring. */
  contentArchetypeId?: string;
};

export type LLMVariant = "full" | "compact" | "compact_fewshot";

/** For logs / ops — does not print the key. */
export type ContentLLMRuntimeDiagnostics = {
  contentLlmEnabledRaw: string | undefined;
  openAiKeyPresent: boolean;
  openAiKeyLength: number;
  llmEnabled: boolean;
  /** When llmEnabled is false — which env condition failed (exact strings for support). */
  reasonIfDisabled: string;
};

export function getContentLLMRuntimeDiagnostics(): ContentLLMRuntimeDiagnostics {
  const raw = process.env.CONTENT_LLM_ENABLED;
  const key = process.env.OPENAI_API_KEY;
  const keyLen = typeof key === "string" ? key.length : 0;
  const keyOk = typeof key === "string" && key.length > 10;
  const flagOk = raw === "true";
  const parts: string[] = [];
  if (!flagOk) {
    parts.push(
      `CONTENT_LLM_ENABLED is not exactly "true" (got: ${raw === undefined ? "undefined" : JSON.stringify(raw)})`
    );
  }
  if (!keyOk) {
    parts.push(
      `OPENAI_API_KEY missing or too short (need string longer than 10 chars; length=${keyLen})`
    );
  }
  return {
    contentLlmEnabledRaw: raw,
    openAiKeyPresent: keyOk,
    openAiKeyLength: keyLen,
    llmEnabled: flagOk && keyOk,
    reasonIfDisabled: parts.length ? parts.join(" | ") : "ok",
  };
}

export function isLLMEnabled(): boolean {
  return getContentLLMRuntimeDiagnostics().llmEnabled;
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
  // Normalize: strip RTL/LTR control chars, normalize smart quotes, strip markdown fences
  const normalized = text
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const repairTrailing = (s: string) => s.replace(/,\s*([}\]])/g, "$1");

  const extract = (s: string): string | null => {
    const m = s.match(/\{[\s\S]*\}/);
    return m ? m[0] : null;
  };

  // Strategy 1: extract JSON object + direct parse
  const extracted = extract(normalized);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // Strategy 2: repair trailing commas in extracted block
      try {
        const result = JSON.parse(repairTrailing(extracted));
        console.info("[content-llm] PARSE_REPAIRED reason=trailing_commas");
        return result;
      } catch { /* fall through */ }
    }
  }

  // Strategy 3: parse the full normalized string directly
  try {
    return JSON.parse(normalized);
  } catch {
    // Strategy 4: repair trailing commas in full string
    try {
      const result = JSON.parse(repairTrailing(normalized));
      console.info("[content-llm] PARSE_REPAIRED reason=trailing_commas_full_text");
      return result;
    } catch {
      return null;
    }
  }
}

export async function tryGenerateWithLLM(
  input: LLMExecutionInput
): Promise<LLMScriptOutput | null> {
  if (!isLLMEnabled()) {
    console.info(
      `[content-llm] FALLBACK_USED FALLBACK_REASON: LLM_NOT_CONFIGURED detail=${getContentLLMRuntimeDiagnostics().reasonIfDisabled}`
    );
    return null;
  }

  const { blueprint, context, plan, contentInsightAnswers, contentArchetypeId } =
    input;

  const variant = getActiveVariant();
  const model = getActiveModel();

  const llmPromptStyle: "full" | "compact" | "compact_fewshot" =
    variant === "compact"
      ? "compact"
      : variant === "compact_fewshot"
        ? "compact_fewshot"
        : "full";

  const writingPackage = buildContentWritingPackage({
    blueprint,
    context,
    plan,
    llmPromptStyle,
    contentInsightAnswers,
    contentArchetypeId,
  });

  console.info(
    `[writing-package] sections=${writingPackage.sections.map((s) => s.id).join(",")}`
  );

  const prompt = toLLMChatPrompt(writingPackage);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.info(
    `[content-llm] START variant=${variant} model=${model} shots=${plan.structure.length} platform=${plan.platform}`
  );

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user",   content: prompt.user },
      ],
      temperature: 0.7,
      max_tokens: 1600,
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content ?? "";
    if (!text.trim()) {
      console.warn(
        `[content-llm] FALLBACK_USED FALLBACK_REASON: EMPTY_LLM_RESPONSE (no message content)`
      );
      return null;
    }

    const raw = safeParseLLMResponse(text);
    if (raw == null) {
      console.warn(
        `[content-llm] FALLBACK_USED FALLBACK_REASON: PARSE_ERROR detail=Could not extract JSON object from model output (first 200 chars): ${text.slice(0, 200).replace(/\s+/g, " ")}`
      );
      return null;
    }

    let validated: LLMScriptOutput;
    try {
      validated = validateLLMOutput(raw, plan.structure.length);
    } catch (e) {
      if (e instanceof LLMOutputValidationError) {
        console.warn(
          `[content-llm] FALLBACK_USED FALLBACK_REASON: VALIDATION_FAILED detail=${e.message}`
        );
        return null;
      }
      throw e;
    }

    // Domain guard — positive relevance check (skipped for generic offer placeholder)
    const domainOk = checkDomainRelevance(validated, context.mainOfferLabel, {
      contentGoalPrompt: context.contentGoalPrompt,
      businessLabel: context.businessLabel,
    });
    if (!domainOk) {
      console.warn(
        `[content-llm] FALLBACK_USED FALLBACK_REASON: DOMAIN_RELEVANCE_FAILED detail=no overlap between output and offer/goal/business tokens offer="${context.mainOfferLabel}"`
      );
      return null;
    }
    if (isNonSpecificMainOfferLabel(context.mainOfferLabel)) {
      console.info(
        `[content-llm] DOMAIN_CHECK_SKIPPED reason=generic_main_offer_placeholder offer="${context.mainOfferLabel}"`
      );
    }

    console.info(
      `[content-llm] SUCCESS model=${model} shots=${validated.shots.length} hookLen=${validated.hook.length}`
    );
    return validated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "Error";
    const isTimeout =
      /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg) ||
      name === "APIConnectionTimeoutError";
    const reason = isTimeout ? "TIMEOUT_OR_NETWORK" : "PROVIDER_ERROR";
    console.error(
      `[content-llm] FALLBACK_USED FALLBACK_REASON: ${reason} detail=${name}: ${msg}`
    );
    return null;
  }
}
