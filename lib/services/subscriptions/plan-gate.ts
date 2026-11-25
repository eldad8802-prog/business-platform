/**
 * The plan gate — the subscription layer's server-side answer for one business, one module and one KIND of action
 * (subscriptions stage C, decisions 1–12). SERVER-ONLY. Every module's own HTTP edge calls it AFTER its flag check
 * (the flag answer is final when it refuses; this gate never opens what a flag closed).
 *
 * ACTIONS
 *   read          viewing the business's own data                                   — never refused by the plan
 *   rights_floor  exporting / downloading what the business is entitled to (tax documents, uniform structure,
 *                 accountant packages already prepared, its originals)                — never refused by the plan
 *   legal         an action the law requires on something that exists (issuing an existing draft, a credit note, a
 *                 receipt for a payment received, a tax-authority decision)          — never refused by the plan
 *   existing      finishing what was started (cancel an appointment, hand over a device, a pickup reminder)
 *                                                                                    — refused only when the module is "none"
 *   write         creating new business work                                         — refused when the module is "limited" or "none"
 *
 * MODES — env SUBSCRIPTION_ENFORCEMENT: off | shadow | enforce (default shadow; see subscription-shadow.ts).
 *   shadow   computes and LOGS what enforce would refuse (subscription_would_deny); always allows.
 *   enforce  refuses — only a CUSTOMER account can ever be refused: testers, internal accounts and businesses without
 *            a record resolve to "full" (resolve-entitlement.ts). Switching to enforce is a separate owner decision.
 * A failed read of the record answers "no record" (full access) and is logged — the gate never fails closed on its
 * own error, because the flag gate in front of it already did.
 */
import type { FeatureAccessReasonCode } from "@/lib/services/feature-access/feature-access.types";
import type { PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

import { resolvePlanEntitlement, type PlanAccess, type PlanReasonCode } from "./resolve-entitlement";
import { loadSubscriptionSnapshot, subscriptionMode } from "./subscription-shadow";
import type { SubscriptionPlan } from "./plan-catalog";
import type { SubscriptionSnapshot } from "./subscription.types";

export type PlanAction = "read" | "rights_floor" | "legal" | "existing" | "write";

export type PlanGateAnswer = {
  allowed: boolean;
  /** What enforce would do (equal to `allowed` in enforce; may differ in shadow). */
  wouldAllow: boolean;
  access: PlanAccess;
  reasonCode: PlanReasonCode;
  requiredPlan: SubscriptionPlan | null;
};

/** Pure: may this action run at this depth of access? */
export function planActionAllowed(access: PlanAccess, action: PlanAction): boolean {
  if (action === "read" || action === "rights_floor" || action === "legal") return true;
  if (action === "existing") return access !== "none";
  return access === "full";
}

/**
 * Routes whose write is NOT new business work (decision 11: everything that waits on the accountant stays open).
 * Matched on the pathname; the first match wins. Anything not listed: GET/HEAD = read, else write.
 */
export const PLAN_ACTION_OVERRIDES: ReadonlyArray<{ pattern: RegExp; action: PlanAction; why: string }> = [
  { pattern: /^\/api\/billing\/documents\/[^/]+\/(lines|payments|allocations|revert)$/, action: "existing", why: "finishing an existing draft (decision 11 — pending the accountant)" },
  { pattern: /^\/api\/billing\/documents\/[^/]+\/(issue|submit|credit-note|authority-decision)$/, action: "legal", why: "legal correction / issuing an existing document" },
  { pattern: /^\/api\/billing\/documents\/[^/]+\/pdf$/, action: "rights_floor", why: "downloading an existing tax document" },
  { pattern: /^\/api\/reports\/(export|export-zip|uniform)$/, action: "rights_floor", why: "exporting the business's own data" },
  { pattern: /^\/api\/appointments\/\d+(\/status|\/reschedule|\/details)?$/, action: "existing", why: "an appointment already booked: cancel / move it (decision 6)" },
  { pattern: /^\/api\/tasks\/\d+(\/[a-z-]+)?$/, action: "existing", why: "finishing a task that exists" },
];

export function planActionForRequest(method: string, pathname: string): PlanAction {
  for (const o of PLAN_ACTION_OVERRIDES) if (o.pattern.test(pathname)) return o.action;
  return defaultPlanAction(method);
}

/** Pure: the method's default action — a read for GET / HEAD, a write for everything else. */
export function defaultPlanAction(method: string): PlanAction {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/** Pure: the whole decision, given the record. Exported for the matrix tests. */
export function decidePlanGate(
  featureKey: PlatformFeatureKey,
  action: PlanAction,
  subscription: SubscriptionSnapshot | null,
  mode: "off" | "shadow" | "enforce",
  flagReasonCode: FeatureAccessReasonCode = "GLOBAL_DEFAULT",
): PlanGateAnswer {
  // The flag already allowed (callers gate on it first); its reason matters only for an admin ENABLED override.
  const ent = resolvePlanEntitlement(featureKey, { allowed: true, reasonCode: flagReasonCode }, subscription);
  const wouldAllow = planActionAllowed(ent.access, action);
  return {
    allowed: mode !== "enforce" || wouldAllow,
    wouldAllow,
    access: ent.access,
    reasonCode: ent.reasonCode,
    requiredPlan: ent.requiredPlan,
  };
}

const FULL: PlanGateAnswer = { allowed: true, wouldAllow: true, access: "full", reasonCode: "TESTER_DEFAULT", requiredPlan: null };

export async function planGate(
  businessId: number,
  featureKey: PlatformFeatureKey,
  action: PlanAction,
  site: string,
  options: { subscription?: SubscriptionSnapshot | null; flagReasonCode?: FeatureAccessReasonCode } = {},
): Promise<PlanGateAnswer> {
  const mode = subscriptionMode();
  if (mode === "off") return FULL;
  const subscription = options.subscription !== undefined ? options.subscription : await loadSubscriptionSnapshot(businessId);
  const answer = decidePlanGate(featureKey, action, subscription, mode, options.flagReasonCode);
  if (!answer.wouldAllow) {
    console.warn(
      JSON.stringify({
        event: mode === "enforce" ? "subscription_denied" : "subscription_would_deny",
        featureKey,
        action,
        site,
        businessId,
        access: answer.access,
        planReason: answer.reasonCode,
        requiredPlan: answer.requiredPlan,
        accountType: subscription?.accountType ?? null,
        status: subscription?.status ?? null,
        plan: subscription?.plan ?? null,
      }),
    );
  }
  return answer;
}

/** The JSON a refused request answers with (403) — the same shape on every module. */
export function planRefusalBody(featureKey: PlatformFeatureKey, answer: PlanGateAnswer): Record<string, unknown> {
  const inactive = answer.reasonCode === "FREE_LIMITED";
  const message = inactive
    ? "תקופת הניסיון הסתיימה. אפשר להמשיך לצפות בכל המידע ולהוריד אותו; כדי ליצור דברים חדשים יש לבחור מסלול במסך \"המנוי שלי\"."
    : "הפעולה הזאת כלולה במסלול גבוה יותר. אפשר לבחור מסלול במסך \"המנוי שלי\".";
  // `error` is the readable message (screens show it verbatim); `code` is machine-readable.
  return {
    error: message,
    code: inactive ? "SUBSCRIPTION_INACTIVE" : "PLAN_REQUIRED",
    feature: featureKey,
    requiredPlan: answer.requiredPlan,
    message,
  };
}
