/**
 * Activity packs — the five ways a business works (owner-approved phase 2, 2026-11-20).
 *
 *   APPOINTMENTS  תורים               barbershops, beauty, clinics
 *   SERVICE       תיקונים ושירות      garages, labs, field technicians
 *   INVENTORY     מלאי ומכירה         shops and trade
 *   LEADS         לידים ומכירות       consultants, agents, sales businesses
 *   ORDERS        הזמנות ופרויקטים    catering, events, installations — on the EXISTING tools only (leads, quotes,
 *                                     payment requests, the calendar); there is no orders / projects module yet.
 *
 * A pack is DISPLAY ONLY: it decides what the Home puts forward, the order of the "+" actions and the tools, and the
 * bottom bar's second slot. It never grants a capability, never changes a price and never turns a feature flag on —
 * entitlement stays with feature access (and, later, the subscription plan), which always filters FIRST.
 *
 * Pure: no I/O. Shared by the API (validation), the capabilities answer and the client.
 */

export const ACTIVITY_PACK_KEYS = ["APPOINTMENTS", "SERVICE", "INVENTORY", "LEADS", "ORDERS"] as const;
export type ActivityPackKey = (typeof ACTIVITY_PACK_KEYS)[number];

/** At most this many additional packs (the DB CHECK says the same: every other pack). */
export const MAX_ADDITIONAL_PACKS = ACTIVITY_PACK_KEYS.length - 1;

/** What a business chose. No selection at all is `null` everywhere — the Home then behaves exactly as before. */
export type ActivitySelection = {
  primary: ActivityPackKey;
  /** In the owner's order, never containing the primary, no duplicates. */
  additional: readonly ActivityPackKey[];
};

export function isActivityPackKey(v: unknown): v is ActivityPackKey {
  return typeof v === "string" && (ACTIVITY_PACK_KEYS as readonly string[]).includes(v);
}

export type SelectionParse = { ok: true; value: ActivitySelection } | { ok: false; error: "PRIMARY_INVALID" | "ADDITIONAL_INVALID" };

/**
 * Validate a selection from an untrusted source (a request body, a stored row). Strict on the primary; the additional
 * list must be an array of known packs — the primary and duplicates are dropped (a harmless repeat from a UI), an
 * unknown value refuses the whole input.
 */
export function parseActivitySelection(input: unknown): SelectionParse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "PRIMARY_INVALID" };
  const o = input as Record<string, unknown>;
  if (!isActivityPackKey(o.primary)) return { ok: false, error: "PRIMARY_INVALID" };
  const raw = o.additional ?? [];
  if (!Array.isArray(raw) || raw.length > ACTIVITY_PACK_KEYS.length * 2) return { ok: false, error: "ADDITIONAL_INVALID" };
  const additional: ActivityPackKey[] = [];
  for (const v of raw) {
    if (!isActivityPackKey(v)) return { ok: false, error: "ADDITIONAL_INVALID" };
    if (v !== o.primary && !additional.includes(v)) additional.push(v);
  }
  return { ok: true, value: { primary: o.primary, additional } };
}

/** A stored row → selection, or null when the row is missing or (defensively) malformed. */
export function selectionFromRow(row: { primaryPack: string; additionalPacks: readonly string[] } | null | undefined): ActivitySelection | null {
  if (!row) return null;
  const parsed = parseActivitySelection({ primary: row.primaryPack, additional: row.additionalPacks });
  return parsed.ok ? parsed.value : null;
}

/** Every pack the business chose, primary first. */
export function selectedPacks(s: ActivitySelection): ActivityPackKey[] {
  return [s.primary, ...s.additional];
}

/**
 * The onboarding categories (lib/business/business-categories.ts values) → the packs suggested for them: the primary
 * pack to pre-select and the additional packs pre-ticked. A suggestion is only a starting point on the selection
 * screen; nothing is stored until the owner confirms. "Other" (and anything unknown) suggests nothing.
 */
export const CATEGORY_SUGGESTION: Record<string, { primary: ActivityPackKey; additional: ActivityPackKey[] } | undefined> = {
  Beauty: { primary: "APPOINTMENTS", additional: [] },
  Fitness: { primary: "APPOINTMENTS", additional: [] },
  Food: { primary: "INVENTORY", additional: [] },
  "Home Services": { primary: "SERVICE", additional: [] },
  Events: { primary: "ORDERS", additional: ["LEADS"] },
  Retail: { primary: "INVENTORY", additional: [] },
  Automotive: { primary: "SERVICE", additional: ["INVENTORY"] },
  "Device Repair": { primary: "SERVICE", additional: ["INVENTORY"] },
  Installations: { primary: "ORDERS", additional: ["SERVICE"] },
  "IT Services": { primary: "SERVICE", additional: [] },
  "Professional Services": { primary: "LEADS", additional: ["APPOINTMENTS"] },
};

/** Sub-categories that move the suggestion (catering is orders, not a shop). */
const SUBCATEGORY_SUGGESTION: Record<string, { primary: ActivityPackKey; additional: ActivityPackKey[] } | undefined> = {
  Catering: { primary: "ORDERS", additional: ["INVENTORY"] },
};

export function suggestionFor(category: string | null | undefined, subCategory?: string | null): ActivitySelection | null {
  const sub = subCategory ? SUBCATEGORY_SUGGESTION[subCategory] : undefined;
  const s = sub ?? (category ? CATEGORY_SUGGESTION[category] : undefined);
  return s ? { primary: s.primary, additional: [...s.additional] } : null;
}

/**
 * The business model the existing profile API requires with a category (service | product | hybrid), derived from
 * the packs ONLY when the business has none yet — an existing value is always kept by the caller.
 */
export function businessModelFor(s: ActivitySelection): "service" | "product" | "hybrid" {
  const packs = selectedPacks(s);
  const sells = packs.includes("INVENTORY");
  const serves = packs.some((p) => p !== "INVENTORY");
  if (sells && serves) return "hybrid";
  return sells ? "product" : "service";
}
