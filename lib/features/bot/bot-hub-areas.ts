/**
 * Hub area-state map (Stage 1) — pure, deterministic.
 *
 * Computes the `ready / partial / soon` chip per builder area from a small set
 * of signals. Stage 1 upgrades personality / approach / voice from hard-coded
 * "soon"/"partial" to real state derived from BusinessBotProfile + identity.
 *
 * Pure: no Prisma, no I/O, never reads the conversation pipeline.
 */

export type BotAreaState = "ready" | "partial" | "soon";

export const BOT_HUB_AREA_IDS = [
  "goal",
  "personality",
  "voice",
  "conversation",
  "approach",
  "knowledge",
  "memory",
  "autonomy",
  "allowed",
  "forbidden",
  "handoff",
  "learning",
] as const;
export type BotHubAreaId = (typeof BOT_HUB_AREA_IDS)[number];

/** Signals needed to derive every area state. */
export type BotHubSignals = {
  /** runtime (BusinessBotSettings) — read-only */
  welcomeOk: boolean;
  questionsCount: number;
  finishOk: boolean;
  productLinkOk: boolean;
  workModeManual: boolean;
  /** new-world (BusinessBot / BusinessBotProfile / BotGoalSelection) */
  identityNamed: boolean;
  voiceExtrasOk: boolean;
  personalityOk: boolean;
  approachOk: boolean;
  goalsCount: number;
};

export type BotHubAreaStateMap = Record<BotHubAreaId, BotAreaState>;

export function computeBotAreaStates(signals: BotHubSignals): BotHubAreaStateMap {
  const voiceState: BotAreaState =
    signals.welcomeOk && (signals.identityNamed || signals.voiceExtrasOk)
      ? "ready"
      : signals.welcomeOk || signals.identityNamed || signals.voiceExtrasOk
        ? "partial"
        : "partial";

  return {
    // Stage 2: real Goal Library — ready once the business selects ≥1 goal.
    goal: signals.goalsCount > 0 ? "ready" : "partial",
    // Upgraded in Stage 1: real persistence via BusinessBotProfile.
    personality: signals.personalityOk ? "ready" : "partial",
    voice: voiceState,
    conversation: signals.questionsCount > 0 ? "ready" : "partial",
    approach: signals.approachOk ? "ready" : "partial",
    knowledge: signals.productLinkOk ? "ready" : "partial",
    // Still no backend in Stage 1.
    memory: "soon",
    autonomy: "partial",
    allowed: signals.finishOk ? "ready" : "partial",
    forbidden: "ready",
    handoff: "ready",
    learning: "soon",
  };
}
