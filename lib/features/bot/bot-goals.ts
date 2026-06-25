/**
 * Goal Library (Stage 2) — canonical, read-only catalog + selection validators.
 *
 * Mirrors the "מטרות הבוט" mockup: goals grouped under 6 categories. This is the
 * SYSTEM (capable of holding goals), not a final content decision — more goals
 * are added by extending the catalog. Data only.
 *
 * HARD BOUNDARY: nothing here is read by the conversation pipeline or the
 * response-planner. No materialization, no activate. A goal SELECTION is a
 * corrigible intent label stored against the business bot with provenance
 * (goalKey + goalVersion + selectedAt) so a future catalog change never
 * retroactively rewrites what the business chose.
 */

import type { Validated } from "./bot-profile";

/** Bumped only when the catalog's MEANING changes; stamped onto new selections. */
export const GOAL_CATALOG_VERSION = 1 as const;

export const GOAL_CATEGORY_KEYS = [
  "new_customers",
  "sales",
  "service",
  "documents",
  "appointments",
  "collections",
] as const;
export type GoalCategoryKey = (typeof GOAL_CATEGORY_KEYS)[number];

export type GoalDef = { key: string; label: string };
export type GoalCategory = {
  key: GoalCategoryKey;
  label: string;
  emoji: string;
  goals: readonly GoalDef[];
};

export const GOAL_CATALOG: readonly GoalCategory[] = [
  {
    key: "new_customers",
    label: "לקוחות חדשים",
    emoji: "🌱",
    goals: [
      { key: "lead_capture", label: "איסוף לידים" },
      { key: "inquiry_screening", label: "סינון פניות" },
      { key: "meeting_scheduling", label: "קביעת פגישות" },
      { key: "call_coordination", label: "תיאום שיחות" },
      { key: "price_quotes", label: "הצעות מחיר" },
    ],
  },
  {
    key: "sales",
    label: "מכירות",
    emoji: "🛍️",
    goals: [
      { key: "order_taking", label: "קבלת הזמנות" },
      { key: "product_sales", label: "מכירת מוצרים" },
      { key: "catalog_sending", label: "שליחת קטלוג" },
      { key: "product_suggestions", label: "הצעת מוצרים" },
      { key: "repurchase_renewal", label: "חידוש רכישות" },
    ],
  },
  {
    key: "service",
    label: "שירות לקוחות",
    emoji: "🎧",
    goals: [
      { key: "faq", label: "שאלות נפוצות" },
      { key: "service_ticket", label: "פתיחת קריאת שירות" },
      { key: "issue_details", label: "איסוף פרטי תקלה" },
      { key: "case_followup", label: "מעקב טיפול" },
    ],
  },
  {
    key: "documents",
    label: "מסמכים",
    emoji: "📄",
    goals: [
      { key: "document_collection", label: "איסוף מסמכים" },
      { key: "image_intake", label: "קבלת תמונות" },
      { key: "document_completion", label: "השלמת מסמכים" },
      { key: "form_intake", label: "קבלת טפסים" },
    ],
  },
  {
    key: "appointments",
    label: "תורים ופגישות",
    emoji: "📅",
    goals: [
      { key: "appointment_booking", label: "קביעת תורים" },
      { key: "appointment_reschedule", label: "שינוי תורים" },
      { key: "appointment_cancel", label: "ביטול תורים" },
      { key: "reminders", label: "תזכורות" },
    ],
  },
  {
    key: "collections",
    label: "גבייה",
    emoji: "💳",
    goals: [
      { key: "payment_reminders", label: "תזכורות תשלום" },
      { key: "receipt_collection", label: "איסוף אסמכתאות" },
      { key: "debt_tracking", label: "מעקב חובות" },
    ],
  },
];

// ── Derived lookups ──────────────────────────────────────────────────────────
const GOAL_KEY_SET: ReadonlySet<string> = new Set(
  GOAL_CATALOG.flatMap((c) => c.goals.map((g) => g.key))
);

export function isGoalKey(key: unknown): key is string {
  return typeof key === "string" && GOAL_KEY_SET.has(key);
}

export function listGoalKeys(): string[] {
  return [...GOAL_KEY_SET];
}

export function getGoalDef(key: string): GoalDef | null {
  for (const cat of GOAL_CATALOG) {
    const found = cat.goals.find((g) => g.key === key);
    if (found) return found;
  }
  return null;
}

/** Catalog integrity: keys unique across the whole catalog. */
export function assertGoalCatalogIntegrity(): void {
  const all = GOAL_CATALOG.flatMap((c) => c.goals.map((g) => g.key));
  if (new Set(all).size !== all.length) {
    throw new Error("GOAL_CATALOG has duplicate goal keys");
  }
}

// ── Selection validator ──────────────────────────────────────────────────────
/**
 * Validate a desired goal selection (array of keys). Unknown keys are REJECTED
 * (hard 400). Duplicates are silently cleaned. Order is preserved.
 */
export function validateGoalSelection(raw: unknown): Validated<string[]> {
  const input = isPlainObject(raw)
    ? (raw as Record<string, unknown>).goals
    : raw;
  if (!Array.isArray(input)) {
    return { ok: false, error: "goals must be an array of goal keys" };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      return { ok: false, error: "each goal must be a string key" };
    }
    if (!isGoalKey(item)) {
      return { ok: false, error: `unknown goal: ${item}` };
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return { ok: true, value: out };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
