/**
 * Memory Policy (Stage 7) — POLICY ONLY, pure validators.
 *
 * Stores WHAT the bot would be allowed to remember about customers in the
 * future. It does NOT store any actual customer memory, does NOT write to
 * Customer, and is NOT read by the response-planner or the pipeline. There is
 * no cross-conversation memory here — only toggles.
 */

import type { Validated } from "./bot-profile";

export const MEMORY_TOGGLE_KEYS = [
  "newOrReturningCustomer",
  "preferences",
  "contactHistory",
  "manualNotes",
  "accumulatedInsights",
] as const;
export type MemoryToggleKey = (typeof MEMORY_TOGGLE_KEYS)[number];

export type BotMemoryPolicy = Record<MemoryToggleKey, boolean>;

export const MEMORY_POLICY_VERSION = 1 as const;

export function emptyMemoryPolicy(): BotMemoryPolicy {
  return {
    newOrReturningCustomer: false,
    preferences: false,
    contactHistory: false,
    manualNotes: false,
    accumulatedInsights: false,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Validate a PUT body. Known toggles must be boolean when present (else 400);
 * unknown keys are dropped. Absent toggles default to false.
 */
export function validateMemoryPolicy(body: unknown): Validated<BotMemoryPolicy> {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const out = emptyMemoryPolicy();
  for (const key of MEMORY_TOGGLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const v = body[key];
    if (typeof v !== "boolean") {
      return { ok: false, error: `${key} must be a boolean` };
    }
    out[key] = v;
  }
  return { ok: true, value: out };
}

/** Forgiving read-side coercion of a stored row. */
export function coerceMemoryPolicy(row: Partial<Record<MemoryToggleKey, unknown>> | null): BotMemoryPolicy {
  const out = emptyMemoryPolicy();
  if (!row) return out;
  for (const key of MEMORY_TOGGLE_KEYS) {
    if (typeof row[key] === "boolean") out[key] = row[key] as boolean;
  }
  return out;
}

/** At least one toggle on → drives the hub "ready" state. */
export function hasMemoryPolicyContent(p: BotMemoryPolicy): boolean {
  return MEMORY_TOGGLE_KEYS.some((k) => p[k]);
}

/** UI labels (single source). */
export const MEMORY_TOGGLE_OPTIONS: ReadonlyArray<{
  key: MemoryToggleKey;
  label: string;
  hint: string;
}> = [
  {
    key: "newOrReturningCustomer",
    label: "לקוח חדש או קבוע",
    hint: "מזהה לפי מספר הטלפון, מתאים את הפתיחה",
  },
  {
    key: "preferences",
    label: "העדפות",
    hint: "שירות מועדף, מטפל מועדף, שעות נוחות",
  },
  {
    key: "contactHistory",
    label: "היסטוריית קשר",
    hint: "תורים קודמים, מה ביקש בעבר",
  },
  {
    key: "manualNotes",
    label: "דברים שכדאי לזכור",
    hint: "הערות שאתה או הבוט מוסיפים ידנית",
  },
  {
    key: "accumulatedInsights",
    label: "מידע שנאסף לאורך זמן",
    hint: "מצטבר משיחה לשיחה — תמונה מלאה יותר",
  },
];
