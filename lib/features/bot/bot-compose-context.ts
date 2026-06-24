/**
 * BotComposeContext (Stage 9A) — pure read-model + a single mechanical voice
 * transform (9B).
 *
 * This is the ONLY new-world data the planner may see, and only the planner's
 * draft WORDING may change. No knowledge, goals, approach, memory, learning or
 * recommendations are exposed here. No LLM, no I/O, no DB writes. The presence
 * of a context is itself the switch — callers (the pipeline) decide whether to
 * pass it based on env flags; this module never reads env.
 */

import {
  coerceStoredProfile,
  type BotLanguage,
  type BotTone,
  type BotVerbosity,
} from "./bot-profile";

export type BotComposeContext = {
  identity: { displayName: string | null };
  voice: { tone: BotTone | null; languages: BotLanguage[] };
  /** Prep only — NOT used by any transform yet. */
  personalityVerbosity: BotVerbosity | null;
};

/** Pure mapper from stored rows → context. Never reads env, never does I/O. */
export function buildBotComposeContext(input: {
  displayName: string | null;
  profile: { voice?: unknown; personality?: unknown; approach?: unknown } | null;
}): BotComposeContext {
  const profile = coerceStoredProfile(input.profile);
  return {
    identity: { displayName: input.displayName ?? null },
    voice: {
      tone: profile.voice?.tone ?? null,
      languages: profile.voice?.languages ?? [],
    },
    personalityVerbosity: profile.personality?.verbosity ?? null,
  };
}

/**
 * 9B mechanical voice transform — WELCOME wording only.
 *
 * Deterministic, no LLM, no translation. If the bot has a display name and the
 * welcome doesn't already mention it, append a name signature line. Otherwise
 * the welcome is returned unchanged. NEVER touches questions, finalAction, or
 * any other reply kind.
 */
export function applyVoiceToWelcome(
  welcome: string,
  context: BotComposeContext
): string {
  const name = context.identity.displayName?.trim();
  if (!name) return welcome;
  if (welcome.includes(name)) return welcome;
  return `${welcome.trimEnd()}\n— ${name}`;
}
