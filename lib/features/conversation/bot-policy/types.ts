/**
 * Pure policy types for Starter Bot — no I/O.
 */

export type BotPolicyDecision =
  | "ALLOW_SUGGESTIONS_ONLY"
  | "HANDOFF_REQUIRED"
  | "STARTER_BOT_ELIGIBLE";

/** Suggested downstream handling (orchestration layer interprets). */
export type BotPolicyNextAction =
  | "CONTINUE_STANDARD_SUGGESTIONS"
  | "REQUIRE_BUSINESS_ATTENTION"
  | "STARTER_AUTOREPLY_ALLOWED";

export type BotPolicyMessageSnapshot = {
  direction: "INBOUND" | "OUTBOUND";
  senderType: "CUSTOMER" | "BUSINESS_USER" | "SYSTEM" | "AI";
  contentText: string | null;
};

export type BotPolicyAnalysisSnapshot = {
  intent: string;
  stage: string;
};

export type BotPolicyConversationSnapshot = {
  status?: string | null;
  currentStage?: string | null;
};

/** Subset of BusinessBotSettings relevant to gating (caller supplies from DB or null). */
export type BotPolicySettingsSnapshot = {
  enabled: boolean;
  mode: string;
  channel: string;
} | null;

export type BotPolicyEngineInput = {
  message: BotPolicyMessageSnapshot;
  analysis: BotPolicyAnalysisSnapshot;
  conversation: BotPolicyConversationSnapshot;
  settings: BotPolicySettingsSnapshot;
  /** Bot Control v1 — optional boundary presets from `handoffRules`. */
  handoffRules?: unknown;
  /** Count of customer inbound messages in thread (for boundary preset). */
  inboundMessageCount?: number;
  /** Owner took over — no bot drafts / eligible. */
  humanTakeover?: boolean;
};

export type BotPolicyEngineResult = {
  decision: BotPolicyDecision;
  reason: string;
  canAutoReply: boolean;
  requiresHandoff: boolean;
  /** Effective bot mode from settings, or "NONE" when absent. */
  mode: string;
  nextAction: BotPolicyNextAction;
};
