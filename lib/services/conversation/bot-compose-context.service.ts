/**
 * BotComposeContext loader + feature flags (Stage 9A/9B).
 *
 * Reads the new-world bot layers READ-ONLY and exposes env kill-switches. All
 * flags default to FALSE — with everything off the pipeline never builds a
 * context and planner output is byte-for-byte unchanged. No DB writes. Does NOT
 * touch bot-control, the draft-only gate, or any send path.
 */

import { prisma } from "@/lib/prisma";
import { buildBotComposeContext, type BotComposeContext } from "@/lib/features/bot";

function envOn(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/** Master kill-switch — when off, no context is built at all. Default false. */
export function isBotComposeContextEnabled(): boolean {
  return envOn("BOT_COMPOSE_CONTEXT_ENABLED");
}

/** Shadow mode — compute new draft for observation but return the old one. */
export function isBotComposeShadowEnabled(): boolean {
  return envOn("BOT_COMPOSE_SHADOW");
}

/** 9B active voice — allow the new (voice-adjusted) welcome to be returned. */
export function isBotVoiceComposeEnabled(): boolean {
  return envOn("BOT_COMPOSE_VOICE_ENABLED");
}

/** 9C knowledge — arm the deterministic knowledge matcher. Default false. */
export function isBotComposeKnowledgeEnabled(): boolean {
  return envOn("BOT_COMPOSE_KNOWLEDGE_ENABLED");
}

/** 9D goals/approach — arm the deterministic closing template. Default false. */
export function isBotComposeGoalsApproachEnabled(): boolean {
  return envOn("BOT_COMPOSE_GOALS_APPROACH_ENABLED");
}

/**
 * Read-only load of the compose context for a business. Returns null when there
 * is no BusinessBot (→ caller falls back to existing behaviour). Never writes.
 *
 * Capabilities are gated by the caller: `includeVoice`/`includeKnowledge` decide
 * which data is populated, so an un-armed capability simply isn't present and
 * the planner can't act on it.
 */
export async function loadBotComposeContext(
  businessId: number,
  options?: {
    includeVoice?: boolean;
    includeKnowledge?: boolean;
    includeGoalsApproach?: boolean;
  }
): Promise<BotComposeContext | null> {
  const includeVoice = options?.includeVoice ?? true;
  const includeKnowledge = options?.includeKnowledge ?? false;
  const includeGoalsApproach = options?.includeGoalsApproach ?? false;

  const bot = await prisma.businessBot.findUnique({
    where: { businessId },
    select: {
      displayName: true,
      profile: { select: { voice: true, personality: true, approach: true } },
      knowledge: includeKnowledge
        ? { select: { hours: true, address: true, notes: true, faq: true } }
        : false,
      goalSelections: includeGoalsApproach
        ? { select: { goalKey: true } }
        : false,
    },
  });
  if (!bot) return null;

  return buildBotComposeContext({
    // Voice transform keys off displayName — withhold it when voice isn't armed.
    displayName: includeVoice ? bot.displayName : null,
    profile: bot.profile,
    knowledge: includeKnowledge ? (bot.knowledge ?? null) : undefined,
    goals: includeGoalsApproach
      ? (bot.goalSelections ?? []).map((g) => g.goalKey)
      : undefined,
    includeApproach: includeGoalsApproach,
  });
}
