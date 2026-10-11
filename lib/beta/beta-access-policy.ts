/**
 * Beta access policy — the ONE place that decides what a closed-beta business may not start yet.
 *
 * WHAT IT IS
 *
 * Dubiz opens to a small cohort of external testers before Google Play. They may use everything except
 * two families of integrations that are not ready for outside testing:
 *
 *   META_WHATSAPP   connecting WhatsApp Business (Embedded Signup)
 *   META_LEAD_ADS   connecting Facebook / Instagram lead forms
 *   TAX_AUTHORITY   connecting the Tax Authority (OAuth), its held-invoice decisions, and issuing a tax
 *                   invoice that would need an allocation number (it could never be delivered without one)
 *
 * For those, a beta business sees "בקרוב" and the server refuses to START them. Nothing else changes:
 * reading what already exists, disconnecting, deleting Meta data and every other feature stay as they are.
 *
 * WHO IS IN THE BETA
 *
 * A business is in the beta iff it has a BusinessBetaEnrollment row. That row is written only in the
 * signup transaction of an account admitted through the closed-beta invitation (lib/auth/signup.ts), and
 * no tenant can write or remove it (migration 20261017090000_beta_cohort_enrollment). Every business that
 * existed before — every Production user today — has no row, so this policy cannot touch them.
 *
 * THE SWITCH (central, reversible, instant)
 *
 *   BETA_COHORT_RESTRICTIONS = "on"   → enrolled businesses are restricted
 *   anything else, including unset    → NOBODY is restricted, and the enrollment table is not even read
 *
 * Turning it off is the whole rollback: no data changes, no code changes. Default OFF on purpose: a
 * missing variable must never restrict an existing business. The other direction — an enrolled business
 * whose enrollment cannot be READ while the switch is on — fails closed for the gated action only.
 *
 * The policy restricts; it never grants. It sits in front of each integration's own gates (feature
 * access, provider configuration, connection state), which keep deciding exactly what they decided.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export const BETA_GATED_CAPABILITIES = ["META_WHATSAPP", "META_LEAD_ADS", "TAX_AUTHORITY"] as const;
export type BetaGatedCapability = (typeof BETA_GATED_CAPABILITIES)[number];

export { CLOSED_BETA_COHORT, CLOSED_BETA_SIGNUP_SOURCE } from "./beta-cohort";

export const BETA_RESTRICTIONS_ENV = "BETA_COHORT_RESTRICTIONS";

/** True only when the switch is explicitly "on". */
export function areBetaRestrictionsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[BETA_RESTRICTIONS_ENV] === "on";
}

export type BetaAccess = {
  /** The business is restricted right now (switch on AND enrolled, or enrollment unreadable). */
  restricted: boolean;
  /** Per capability: show "בקרוב" and refuse to start it. */
  comingSoon: Record<BetaGatedCapability, boolean>;
};

const NONE: BetaAccess = Object.freeze({
  restricted: false,
  comingSoon: Object.freeze({ META_WHATSAPP: false, META_LEAD_ADS: false, TAX_AUTHORITY: false }),
}) as BetaAccess;

const ALL: BetaAccess = Object.freeze({
  restricted: true,
  comingSoon: Object.freeze({ META_WHATSAPP: true, META_LEAD_ADS: true, TAX_AUTHORITY: true }),
}) as BetaAccess;

/** Pure decision. `enrolled: "unknown"` = the switch is on but the enrollment could not be read. */
export function decideBetaAccess(input: {
  restrictionsOn: boolean;
  enrolled: boolean | "unknown";
}): BetaAccess {
  if (!input.restrictionsOn) return NONE;
  if (input.enrolled === false) return NONE;
  return ALL; // enrolled, or unreadable while on → fail closed
}

export type BetaPolicyDeps = {
  restrictionsOn: () => boolean;
  /** Reads THIS business's enrollment (tenant-scoped). */
  isEnrolled: (businessId: number) => Promise<boolean>;
};

async function isEnrolledTenant(businessId: number): Promise<boolean> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const row = await tx.businessBetaEnrollment.findUnique({
        where: { businessId },
        select: { businessId: true },
      });
      return row !== null;
    })
  );
}

export const defaultBetaPolicyDeps: BetaPolicyDeps = {
  restrictionsOn: () => areBetaRestrictionsOn(),
  isEnrolled: isEnrolledTenant,
};

/**
 * The business's beta access. With the switch off it returns at once — no database read at all, so a
 * deployment with the switch off behaves exactly like one without this module.
 */
export async function resolveBetaAccess(
  businessId: number,
  deps: BetaPolicyDeps = defaultBetaPolicyDeps
): Promise<BetaAccess> {
  if (!deps.restrictionsOn()) return NONE;
  let enrolled: boolean | "unknown";
  try {
    enrolled = await deps.isEnrolled(businessId);
  } catch (error) {
    console.error("[beta-access] enrollment unreadable — failing closed", {
      businessId,
      error: error instanceof Error ? error.name : "unknown",
    });
    enrolled = "unknown";
  }
  return decideBetaAccess({ restrictionsOn: true, enrolled });
}

/** Read-only check used by the client view; same rules. */
export async function isBetaCapabilityComingSoon(
  businessId: number,
  capability: BetaGatedCapability,
  deps: BetaPolicyDeps = defaultBetaPolicyDeps
): Promise<boolean> {
  return (await resolveBetaAccess(businessId, deps)).comingSoon[capability];
}

