/**
 * Structured Fields Foundation — Stage A normalizer.
 *
 * Single entry point that turns WHATEVER is stored in
 * `BusinessBotSettings.questions` into a uniform `BotField[]`:
 *
 *   - legacy `{ items: string[] }`  → one `text` field per item
 *                                     (id/key = `legacy_0`, `legacy_1`, …)
 *   - v2 `{ version: 2, fields: [] }` → validated `BotField[]`
 *   - anything else / malformed      → `[]` (NEVER throws)
 *
 * Hard guarantees (backward compatibility):
 *   - This module is READ-ONLY and side-effect-free. It does not persist,
 *     mutate, or touch the conversation flow.
 *   - It never throws on bad input — a corrupt `questions` blob degrades to
 *     an empty list, so it can be called safely from any runtime path.
 *   - It does NOT replace the live planner's `parseQuestionItems`; the
 *     existing flow keeps reading the legacy `{ items }` shape untouched.
 */

import {
  BOT_FIELD_MAP_TARGETS,
  BOT_FIELD_TYPES,
  BOT_FIELDS_VERSION,
  type BotField,
  type BotFieldMapTarget,
  type BotFieldOption,
  type BotFieldType,
} from "./bot-field.types";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function isBotFieldType(v: unknown): v is BotFieldType {
  return typeof v === "string" && (BOT_FIELD_TYPES as readonly string[]).includes(v);
}

function isMapTarget(v: unknown): v is BotFieldMapTarget {
  return (
    typeof v === "string" &&
    (BOT_FIELD_MAP_TARGETS as readonly string[]).includes(v)
  );
}

function parseOptions(v: unknown): BotFieldOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BotFieldOption[] = [];
  for (const raw of v) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const value = asNonEmptyString(rec.value);
    const label = asNonEmptyString(rec.label);
    if (!value || !label) continue;
    out.push({ value, label });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Detects the legacy `{ items: string[] }` shape. Tolerant: a non-string
 * item is simply skipped during conversion, not treated as a hard failure.
 */
export function isLegacyQuestions(raw: unknown): boolean {
  const rec = asRecord(raw);
  return !!rec && Array.isArray(rec.items);
}

/** Maps the legacy free-text questions to uniform `text` fields. */
export function legacyItemsToBotFields(items: unknown): BotField[] {
  if (!Array.isArray(items)) return [];
  const out: BotField[] = [];
  items.forEach((item, index) => {
    const question = asNonEmptyString(item);
    if (!question) return;
    out.push({
      id: `legacy_${index}`,
      key: `legacy_${index}`,
      label: question.trim(),
      question: question.trim(),
      type: "text",
      required: false,
      mapsTo: null,
    });
  });
  return out;
}

/**
 * Validates a single candidate v2 field. Returns `null` when required props
 * are missing/invalid so the caller can drop it without failing the batch.
 */
export function parseBotField(raw: unknown): BotField | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const type = isBotFieldType(rec.type) ? rec.type : null;
  if (!type) return null;

  const question = asNonEmptyString(rec.question);
  if (!question) return null;

  // key/id fall back to each other; label falls back to the question.
  const key = asNonEmptyString(rec.key) ?? asNonEmptyString(rec.id);
  if (!key) return null;
  const id = asNonEmptyString(rec.id) ?? key;
  const label = asNonEmptyString(rec.label) ?? question;

  const required = rec.required === true;

  const field: BotField = {
    id,
    key,
    label: label.trim(),
    question: question.trim(),
    type,
    required,
    mapsTo: isMapTarget(rec.mapsTo) ? rec.mapsTo : null,
  };

  if (type === "select" || type === "multiselect") {
    const options = parseOptions(rec.options);
    if (options) field.options = options;
  }

  return field;
}

/** Parses a v2 `{ version: 2, fields: [] }` config into validated fields. */
export function v2ConfigToBotFields(raw: unknown): BotField[] {
  const rec = asRecord(raw);
  if (!rec || !Array.isArray(rec.fields)) return [];
  const out: BotField[] = [];
  for (const candidate of rec.fields) {
    const field = parseBotField(candidate);
    if (field) out.push(field);
  }
  return out;
}

/**
 * THE entry point. Accepts the raw `BusinessBotSettings.questions` value and
 * always returns a uniform `BotField[]`. Never throws.
 */
export function normalizeBotFields(questions: unknown): BotField[] {
  const rec = asRecord(questions);
  if (!rec) return [];

  // v2 takes precedence when explicitly versioned.
  if (rec.version === BOT_FIELDS_VERSION && Array.isArray(rec.fields)) {
    return v2ConfigToBotFields(rec);
  }

  // Legacy free-text questions.
  if (Array.isArray(rec.items)) {
    return legacyItemsToBotFields(rec.items);
  }

  // Unknown / malformed → safe empty list.
  return [];
}

/**
 * Backward-compat bridge for a FUTURE writer: collapse structured fields back
 * to the legacy `string[]` the live planner still reads. Unused in Stage A —
 * provided so a later save path can keep `{ items }` in sync and never strand
 * the existing conversation flow.
 */
export function botFieldsToLegacyItems(fields: BotField[]): string[] {
  return fields
    .map((f) => f.question.trim())
    .filter((q) => q.length > 0);
}
