/**
 * Activity packs — what the selection screen pre-ticks, and the business model it fills in for a business that has
 * none. Used ONLY by the activity screens (components/activity-packs), so it is its own module: nothing here ships
 * with the pages every business opens (Hebrew JS budget, i18n en-chunk proof).
 */
import { selectedPacks, type ActivityPackKey, type ActivitySelection } from "./activity-packs";

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
