import {
  evaluateBotGuardrails,
  evaluateBotResponseGuardrails,
} from "@/lib/features/conversation/guardrails";
import { buildBotLlmPrompt } from "./prompt-builder";
import type {
  BotLlmDraftDeps,
  BotLlmDraftInput,
  BotLlmDraftResult,
} from "./types";

/**
 * Generate an LLM reply DRAFT, wrapped in pre + post canonical Guardrails.
 *
 * Order (matches the required flow):
 *   1. PRE-guardrail on the message + context.
 *   2. If handoff required → return handoff, DO NOT call the LLM.
 *   3/4. Build the prompt and generate a draft (never sends).
 *   5. POST-guardrail on the generated text.
 *   6. If the output violates a guardrail → handoff, do NOT surface the draft.
 *   7. Otherwise → return the draft (caller persists it as GENERATED).
 *
 * Pure except for the injected `deps.complete`, so the whole flow is testable
 * with a fake model.
 */
export async function generateBotLlmDraft(
  input: BotLlmDraftInput,
  deps: BotLlmDraftDeps
): Promise<BotLlmDraftResult> {
  // 1–2. Pre-response guardrails. Never call the model when a handoff is due.
  const pre = evaluateBotGuardrails(input.guardrailInput);
  if (pre.requiresHandoff) {
    return { kind: "handoff", phase: "pre", reason: pre.reason };
  }

  // 3–4. Build the prompt and generate a draft (draft only — no send).
  const prompt = buildBotLlmPrompt(input.promptData);
  let text: string | null;
  try {
    text = await deps.complete(prompt);
  } catch {
    return { kind: "no_draft", reason: "LLM_ERROR" };
  }
  if (!text || !text.trim()) {
    return { kind: "no_draft", reason: "LLM_EMPTY" };
  }

  // 5–6. Post-response guardrails on the generated text.
  const post = evaluateBotResponseGuardrails({
    proposedText: text,
    handoffRules: input.handoffRules,
  });
  if (!post.allowed && post.reason) {
    return { kind: "handoff", phase: "post", reason: post.reason };
  }

  // 7. Clean draft.
  return { kind: "draft", text: text.trim() };
}
