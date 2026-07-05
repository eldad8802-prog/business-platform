/**
 * LLM Draft generator — types.
 *
 * First LLM reply generator. Produces a DRAFT for the business owner only —
 * never auto-sent. Wrapped in pre + post canonical Guardrails and gated by a
 * default-off feature flag. Pure/DI orchestrator (`complete` is injected) so the
 * full guardrail flow is testable without a real model call.
 */
import type { BotGuardrailInput } from "@/lib/features/conversation/guardrails";
import type { BotForbiddenPresets } from "@/lib/features/conversation/bot-control";

export type BotLlmPromptContextMessage = {
  direction: "INBOUND" | "OUTBOUND";
  text: string;
};

/** Everything the prompt consumes from the Bot Builder + BusinessBotSettings. */
export type BotLlmPromptData = {
  displayName?: string | null;
  welcomeMessage?: string | null;
  questions?: string[];
  finalAction?: string | null;
  voiceTone?: string | null;
  voiceLanguages?: string[];
  personalityTraits?: string[];
  personalityVerbosity?: string | null;
  approachSaleStyle?: string | null;
  approachInitiative?: string | null;
  approachPriorities?: string[];
  goals?: string[];
  knowledgeHours?: string | null;
  knowledgeAddress?: string | null;
  knowledgeNotes?: string | null;
  faq?: Array<{ question: string; answer: string }>;
  forbidden?: BotForbiddenPresets;
  customerMessage: string;
  recentMessages?: BotLlmPromptContextMessage[];
};

export type BotLlmPrompt = { system: string; user: string };

export type BotLlmDraftInput = {
  /** Pre-response guardrail input (message + analysis + settings + handoffRules + context). */
  guardrailInput: BotGuardrailInput;
  /** Everything the prompt needs from Bot Builder + settings. */
  promptData: BotLlmPromptData;
  /** Owner rules blob for the post-response guardrail (BusinessBotSettings.handoffRules). */
  handoffRules?: unknown;
};

export type BotLlmDraftDeps = {
  /** Returns the model's reply text, or null on empty/failure. Injected. */
  complete: (prompt: BotLlmPrompt) => Promise<string | null>;
};

export type BotLlmDraftResult =
  | { kind: "draft"; text: string }
  | { kind: "handoff"; phase: "pre" | "post"; reason: string }
  | { kind: "no_draft"; reason: string };
