/**
 * Leads L1.5-b · B1 — WHY a source is refused for a business, told apart (classification only: every refusal is
 * still a refusal, nothing is recorded, the HTTP answers are unchanged).
 *
 *   emergency      the Dubiz emergency switch (already held, not refused — unchanged)
 *   plan_excluded  a platform-admin DISABLED override whose reason carries the structured marker "plan:excluded":
 *                  the source left the business's plan. Only this one may later (B2, off) record-and-hold a delivery
 *                  from a live, verified connection — never in this PR
 *   blocked        any other DISABLED override (a deliberate block, a free-text or empty reason): never held
 *   not_entitled   no grant for this business now (never granted, or the grant removed without the plan marker):
 *                  never held
 *
 * Fail-closed: only the exact marker counts; anything unreadable or unknown is "blocked" / "not_entitled", so the
 * classification can never widen what Dubiz accepts.
 */
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";

export type SourceRefusal = "emergency" | "plan_excluded" | "blocked" | "not_entitled";

/** The structured override reason that marks "the source left the plan" (an optional note may follow a space). */
export const PLAN_EXCLUDED_REASON = "plan:excluded";

export function isPlanExcludedReason(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  return reason === PLAN_EXCLUDED_REASON || reason.startsWith(PLAN_EXCLUDED_REASON + " ");
}

/** Pure: a refused feature-access answer (+ the override's reason, when it is a DISABLED override) → the refusal. */
export function classifySourceRefusal(reasonCode: FeatureAccessResult["reasonCode"], overrideReason: string | null): SourceRefusal {
  if (reasonCode === "EMERGENCY_DISABLED") return "emergency";
  if (reasonCode === "BUSINESS_DISABLED") return isPlanExcludedReason(overrideReason) ? "plan_excluded" : "blocked";
  return "not_entitled";
}
