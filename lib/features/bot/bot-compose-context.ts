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
  type BotInitiativeLevel,
  type BotLanguage,
  type BotPriority,
  type BotSaleStyle,
  type BotTone,
  type BotVerbosity,
} from "./bot-profile";
import { coerceKnowledge, type BotKnowledge, type FaqItem } from "./bot-knowledge";
import { coerceSelectedGoalKeys } from "./bot-setup";

export type BotComposeKnowledge = {
  faq: FaqItem[];
  hours: string | null;
  address: string | null;
  notes: string | null;
};

export type BotComposeApproach = {
  saleStyle: BotSaleStyle | null;
  initiativeLevel: BotInitiativeLevel | null;
  priorities: BotPriority[];
};

export type BotComposeContext = {
  identity: { displayName: string | null };
  voice: { tone: BotTone | null; languages: BotLanguage[] };
  /** Used mechanically by the 9D closing template (length only). */
  personalityVerbosity: BotVerbosity | null;
  /** 9C — present only when the knowledge capability is armed. */
  knowledge?: BotComposeKnowledge;
  /** The inbound customer text, for conservative knowledge matching. */
  customerMessageText?: string;
  /** 9D — present only when the goals/approach capability is armed. */
  goals?: string[];
  /** 9D — present only when the goals/approach capability is armed. */
  approach?: BotComposeApproach;
};

/** Pure mapper from stored rows → context. Never reads env, never does I/O. */
export function buildBotComposeContext(input: {
  displayName: string | null;
  profile: { voice?: unknown; personality?: unknown; approach?: unknown } | null;
  knowledge?: { hours?: unknown; address?: unknown; notes?: unknown; faq?: unknown } | null;
  /** 9D — provide to arm goals; selected goal keys. */
  goals?: string[];
  /** 9D — provide to arm approach (mapped from the profile). */
  includeApproach?: boolean;
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
  if (input.goals !== undefined) {
    context.goals = coerceSelectedGoalKeys(input.goals);
  }
  if (input.includeApproach) {
    context.approach = {
      saleStyle: profile.approach?.saleStyle ?? null,
      initiativeLevel: profile.approach?.initiativeLevel ?? null,
      priorities: profile.approach?.priorities ?? [],
    };
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

// ── 9D: deterministic closing template from goals/approach/verbosity ─────────
const SCHEDULING_GOALS = new Set([
  "appointment_booking",
  "meeting_scheduling",
  "appointment_reschedule",
]);

const GENERIC_CLOSING: Record<BotVerbosity, string> = {
  short: "קיבלתי 👍 אחזור אליך בהקדם.",
  medium: "תודה! קיבלתי את הפרטים, אחזור אליך בהקדם להמשך.",
  detailed: "תודה רבה! קיבלתי את כל הפרטים. אעבור עליהם ואחזור אליך בהקדם להמשך.",
};
const SCHEDULING_CLOSING: Record<BotVerbosity, string> = {
  short: "קיבלתי 👍 אחזור לאשר את התור.",
  medium: "תודה! קיבלתי את הפרטים, אחזור אליך לאישור התור.",
  detailed: "תודה רבה! קיבלתי את הפרטים לקביעת התור. אבדוק זמינות ואחזור אליך לאישור.",
};
/** Benign, fixed invitation — never mentions price/availability/promises. */
const SOFT_SELLING_SUFFIX = " נשמח להציע לך גם מה שמתאים.";

type ComposeStyle = {
  schedulingGoal: boolean;
  sellingLean: "none" | "soft" | "active";
  verbosity: BotVerbosity;
};

/** Pure: derive a deterministic style, or null when there's no goal/approach basis. */
export function deriveComposeStyle(context: BotComposeContext): ComposeStyle | null {
  const goals = context.goals ?? [];
  const approach = context.approach;
  const hasGoals = goals.length > 0;
  const hasApproach = !!(
    approach &&
    (approach.saleStyle || approach.initiativeLevel || approach.priorities.length > 0)
  );
  if (!hasGoals && !hasApproach) return null;

  const sellingLean: ComposeStyle["sellingLean"] =
    approach?.saleStyle === "active"
      ? "active"
      : approach?.saleStyle === "soft" || approach?.saleStyle === "opportunistic"
        ? "soft"
        : "none";

  return {
    schedulingGoal: goals.some((g) => SCHEDULING_GOALS.has(g)),
    sellingLean,
    verbosity: context.personalityVerbosity ?? "medium",
  };
}

/**
 * Choose a deterministic CLOSING wording for the terminal draft. Returns null
 * (→ caller keeps the existing closing) unless the finalAction is a generic
 * acknowledgement (LEAVE_MESSAGE / COLLECT_DETAILS) AND there is a goal/approach
 * basis. NEVER applies to SEND_LINK (carries a URL) or ESCALATE (handoff), and
 * never changes questions / finalAction / handoff / replyKind.
 */
export function chooseClosingTemplate(
  context: BotComposeContext,
  finalAction: string | null
): string | null {
  if (finalAction !== "LEAVE_MESSAGE" && finalAction !== "COLLECT_DETAILS") {
    return null;
  }
  const style = deriveComposeStyle(context);
  if (!style) return null;

  const table = style.schedulingGoal ? SCHEDULING_CLOSING : GENERIC_CLOSING;
  let text = table[style.verbosity];
  if (!style.schedulingGoal && style.sellingLean !== "none") {
    text += SOFT_SELLING_SUFFIX;
  }
  return text;
}
