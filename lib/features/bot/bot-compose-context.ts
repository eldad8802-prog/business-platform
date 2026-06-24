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
import { coerceKnowledge, type BotKnowledge, type FaqItem } from "./bot-knowledge";

export type BotComposeKnowledge = {
  faq: FaqItem[];
  hours: string | null;
  address: string | null;
  notes: string | null;
};

export type BotComposeContext = {
  identity: { displayName: string | null };
  voice: { tone: BotTone | null; languages: BotLanguage[] };
  /** Prep only — NOT used by any transform yet. */
  personalityVerbosity: BotVerbosity | null;
  /** 9C — present only when the knowledge capability is armed. */
  knowledge?: BotComposeKnowledge;
  /** The inbound customer text, for conservative knowledge matching. */
  customerMessageText?: string;
};

/** Pure mapper from stored rows → context. Never reads env, never does I/O. */
export function buildBotComposeContext(input: {
  displayName: string | null;
  profile: { voice?: unknown; personality?: unknown; approach?: unknown } | null;
  knowledge?: { hours?: unknown; address?: unknown; notes?: unknown; faq?: unknown } | null;
}): BotComposeContext {
  const profile = coerceStoredProfile(input.profile);
  const context: BotComposeContext = {
    identity: { displayName: input.displayName ?? null },
    voice: {
      tone: profile.voice?.tone ?? null,
      languages: profile.voice?.languages ?? [],
    },
    personalityVerbosity: profile.personality?.verbosity ?? null,
  };
  if (input.knowledge !== undefined) {
    const k: BotKnowledge = coerceKnowledge(input.knowledge);
    context.knowledge = { faq: k.faq, hours: k.hours, address: k.address, notes: k.notes };
  }
  return context;
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

// ── 9C: conservative deterministic knowledge matcher ─────────────────────────
export type KnowledgeMatchType = "faq" | "hours" | "address";
export type KnowledgeMatch = { replyText: string; matchType: KnowledgeMatchType };

const HOURS_TRIGGERS = [
  "שעות",
  "פתוח",
  "פתוחים",
  "מתי אתם עובדים",
  "מתי עובדים",
  "מתי פתוח",
  "שעות פעילות",
];
const ADDRESS_TRIGGERS = [
  "איפה",
  "כתובת",
  "מיקום",
  "איך מגיעים",
  "איך להגיע",
  "ניווט",
];

function norm(t: string): string {
  return t.toLowerCase().trim();
}

/**
 * Conservative, deterministic intent → knowledge answer. NO LLM, NO fuzzy
 * matching. Returns null whenever there is any doubt. Priority: FAQ → hours →
 * address. `notes` is intentionally NOT matched (no safe deterministic trigger).
 * Never touches questions / finalAction / handoff.
 */
export function matchKnowledgeIntent(
  messageText: string | undefined,
  knowledge: BotComposeKnowledge | undefined
): KnowledgeMatch | null {
  if (!knowledge) return null;
  const msg = norm(messageText ?? "");
  if (msg.length < 4) return null;

  // 1. FAQ — contains-based both directions, requires a real answer.
  for (const item of knowledge.faq) {
    const q = norm(item.question).replace(/[?؟]/g, "").trim();
    const answer = item.answer.trim();
    if (q.length < 4 || answer.length === 0) continue;
    if (msg.includes(q) || q.includes(msg)) {
      return { replyText: answer, matchType: "faq" };
    }
  }

  // 2. hours
  if (knowledge.hours && HOURS_TRIGGERS.some((t) => msg.includes(t))) {
    return { replyText: `שעות הפעילות שלנו: ${knowledge.hours}`, matchType: "hours" };
  }

  // 3. address
  if (knowledge.address && ADDRESS_TRIGGERS.some((t) => msg.includes(t))) {
    return { replyText: `הכתובת שלנו: ${knowledge.address}`, matchType: "address" };
  }

  return null;
}
