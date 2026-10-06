/**
 * Closed Loop · the owner recommendation surface, server side.
 *
 * Gated by the platform feature `owner_recommendations` (default OFF; enabled per business through the audited
 * platform-admin feature-access path, with its emergency kill). Off → the surface does not exist for the
 * business: the list says `enabled: false` and a decision is refused (403).
 *
 * Reads only through outcome-store (one tenant transaction, the session's business). Wording is the pure
 * owner-view: deterministic, sequence-only, no model.
 */
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { loadOwnerRecommendations } from "./outcome-store";
import { buildOwnerView, NOT_NOW_CHOICES, OWNER_VIEW_VERSION, REASON_OPTIONS, type OwnerRecommendationView } from "./owner-view";

export async function ownerRecommendationsEnabled(businessId: number): Promise<boolean> {
  try {
    return (await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.OWNER_RECOMMENDATIONS)).allowed === true;
  } catch {
    return false; // fail closed: an unreadable policy is "off"
  }
}

export type OwnerRecommendationsPayload =
  | { enabled: false }
  | {
      enabled: true;
      viewVersion: string;
      items: OwnerRecommendationView[];
      counts: { waiting: number; in_progress: number; closed: number };
      reasons: typeof REASON_OPTIONS;
      notNow: typeof NOT_NOW_CHOICES;
    };

const STAGE_ORDER = { waiting: 0, in_progress: 1, closed: 2 } as const;

export async function ownerRecommendations(businessId: number, now: Date, opts: { id?: number } = {}): Promise<OwnerRecommendationsPayload> {
  if (!(await ownerRecommendationsEnabled(businessId))) return { enabled: false };
  const { items } = await loadOwnerRecommendations(businessId, now, opts);
  const views = items.map((row) => buildOwnerView(row, now))
    .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || b.issuedAt.localeCompare(a.issuedAt) || b.id - a.id);
  const counts = { waiting: 0, in_progress: 0, closed: 0 };
  for (const v of views) counts[v.stage] += 1;
  return { enabled: true, viewVersion: OWNER_VIEW_VERSION, items: views, counts, reasons: REASON_OPTIONS, notNow: NOT_NOW_CHOICES };
}
