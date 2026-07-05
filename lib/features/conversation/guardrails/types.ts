/**
 * Canonical Bot Guardrails — types.
 *
 * The Guardrails layer is the SINGLE decision point every bot engine (STARTER
 * draft, AUTO suggestions, and the future autonomous LLM responder) passes
 * through. It runs BEFORE a reply is drafted (pre-response) and exposes a
 * prepared interface to run AFTER a reply is proposed (post-response, for the
 * future LLM). It wraps the existing policy/boundary/handoff logic and enforces
 * owner-defined forbidden topics ("מה אסור"), over the current message AND
 * recent conversation context.
 */
import type {
  BotPolicyEngineInput,
  BotPolicyEngineResult,
} from "@/lib/features/conversation/bot-policy";

/** A recent message supplied as context for context-aware guardrail checks. */
export type BotGuardrailContextMessage = {
  direction: "INBOUND" | "OUTBOUND";
  contentText: string | null;
  intent?: string | null;
  stage?: string | null;
  createdAt?: string | number | Date | null;
};

/** Optional conversation context for the guardrails layer. */
export type BotGuardrailContext = {
  /** Recent messages, most-recent last. Only INBOUND ones are scanned. */
  recentMessages?: BotGuardrailContextMessage[];
};

/**
 * Pre-response guardrail input — the policy engine's contract plus optional
 * conversation `context`. The extra field is ignored by the policy engine.
 */
export type BotGuardrailInput = BotPolicyEngineInput & {
  context?: BotGuardrailContext;
};

/**
 * Superset of the policy result so existing callers keyed on `decision` /
 * `requiresHandoff` keep working unchanged, plus an engine-agnostic
 * `canRespond` that any bot engine can read.
 */
export type BotGuardrailDecision = BotPolicyEngineResult & {
  /** May ANY bot engine draft a reply for this inbound message right now? */
  canRespond: boolean;
};

/**
 * Post-response guardrail input — a prepared interface for validating text the
 * bot is ABOUT to propose (deterministic today; the seam for LLM output next).
 */
export type BotResponseGuardrailInput = {
  /** The text the bot is about to propose as a draft/suggestion. */
  proposedText: string;
  /** Owner rules blob (BusinessBotSettings.handoffRules); forbidden parsed from it. */
  handoffRules?: unknown;
  /** Optional conversation context (reserved for future use). */
  context?: BotGuardrailContext;
};

export type BotResponseGuardrailDecision = {
  /** Is the proposed text allowed to be shown/sent? */
  allowed: boolean;
  /** Must this be handed off to the owner instead? */
  requiresHandoff: boolean;
  /** Machine reason code when blocked, else null. */
  reason: string | null;
};
