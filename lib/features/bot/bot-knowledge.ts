/**
 * Bot Knowledge (Stage 4) — advisory business knowledge for the bot builder.
 *
 * Stores FAQ / hours / address / notes the business wants its bot to "know".
 * ADVISORY ONLY in this stage: NOT read by the response-planner or the
 * pipeline, NOT materialized into BusinessBotSettings. services/pricing and the
 * catalog link keep their existing sources of truth (BusinessService /
 * BusinessBotSettings.productLink*) — surfaced read-only by the hub, never
 * duplicated here.
 */

import type { Validated } from "./bot-profile";

export const MAX_HOURS_CHARS = 200;
export const MAX_ADDRESS_CHARS = 200;
export const MAX_NOTES_CHARS = 2000;
export const MAX_FAQ_ITEMS = 30;
export const MAX_FAQ_QUESTION_CHARS = 200;
export const MAX_FAQ_ANSWER_CHARS = 1000;

export type FaqItem = { question: string; answer: string };

export type BotKnowledge = {
  hours: string | null;
  address: string | null;
  notes: string | null;
  faq: FaqItem[];
};

export function emptyKnowledge(): BotKnowledge {
  return { hours: null, address: null, notes: null, faq: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function optionalString(
  raw: unknown,
  max: number,
  field: string
): Validated<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

function validateFaq(raw: unknown): Validated<FaqItem[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "faq must be an array" };
  if (raw.length > MAX_FAQ_ITEMS) {
    return { ok: false, error: `faq exceeds ${MAX_FAQ_ITEMS} items` };
  }
  const out: FaqItem[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: "each faq item must be an object" };
    }
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
    if (!question) continue; // drop empty rows (forgiving)
    if (question.length > MAX_FAQ_QUESTION_CHARS) {
      return { ok: false, error: "faq question is too long" };
    }
    if (answer.length > MAX_FAQ_ANSWER_CHARS) {
      return { ok: false, error: "faq answer is too long" };
    }
    out.push({ question, answer });
  }
  return { ok: true, value: out };
}

/** Validate a PUT body that fully replaces the knowledge record. */
export function validateKnowledge(body: unknown): Validated<BotKnowledge> {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const hours = optionalString(body.hours, MAX_HOURS_CHARS, "hours");
  if (!hours.ok) return hours;
  const address = optionalString(body.address, MAX_ADDRESS_CHARS, "address");
  if (!address.ok) return address;
  const notes = optionalString(body.notes, MAX_NOTES_CHARS, "notes");
  if (!notes.ok) return notes;
  const faq = validateFaq(body.faq);
  if (!faq.ok) return faq;

  return {
    ok: true,
    value: {
      hours: hours.value,
      address: address.value,
      notes: notes.value,
      faq: faq.value,
    },
  };
}

/** Forgiving read-side coercion of a stored row. */
export function coerceKnowledge(row: {
  hours?: unknown;
  address?: unknown;
  notes?: unknown;
  faq?: unknown;
} | null): BotKnowledge {
  if (!row) return emptyKnowledge();
  const hours = optionalString(row.hours, MAX_HOURS_CHARS, "hours");
  const address = optionalString(row.address, MAX_ADDRESS_CHARS, "address");
  const notes = optionalString(row.notes, MAX_NOTES_CHARS, "notes");
  const faq = validateFaq(row.faq);
  return {
    hours: hours.ok ? hours.value : null,
    address: address.ok ? address.value : null,
    notes: notes.ok ? notes.value : null,
    faq: faq.ok ? faq.value : [],
  };
}

/** Real, business-authored knowledge present (drives hub "ready" state). */
export function hasKnowledgeContent(k: BotKnowledge): boolean {
  return !!k.hours || !!k.address || !!k.notes || k.faq.length > 0;
}
