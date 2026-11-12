/**
 * Controlled completion of the legal identity for an EXISTING business (owner decision 2026-11-12: new businesses
 * confirm it at signup; existing ones are never blocked, overwritten or locked by surprise).
 *
 * OFF by default: LEGAL_IDENTITY_COMPLETION_ENABLED must be exactly "true" (a separate owner approval). Nothing
 * calls this automatically; no screen links to it yet.
 *
 * What it does, in the business's own tenant transaction:
 *   1. a tax id stored with separators, or with 8 digits, is rewritten to its canonical nine digits — the same
 *      number, never a different one (the row is not locked yet, so the runtime may);
 *   2. legal_identity_confirm_existing(user) confirms what is stored — it never writes an identity value — and
 *      answers CONFIRMED | ALREADY_CONFIRMED | INCOMPLETE | INVALID_TAX_ID | NOT_ALLOWED.
 * From CONFIRMED on, kind / legal name / tax id are locked exactly as for a business confirmed at signup.
 */

import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type LegalIdentityCompletionResult =
  | "CONFIRMED"
  | "ALREADY_CONFIRMED"
  | "INCOMPLETE"
  | "INVALID_TAX_ID"
  | "NOT_ALLOWED";

const RESULTS: readonly LegalIdentityCompletionResult[] = [
  "CONFIRMED", "ALREADY_CONFIRMED", "INCOMPLETE", "INVALID_TAX_ID", "NOT_ALLOWED",
];

export function isLegalIdentityCompletionEnabled(): boolean {
  return process.env.LEGAL_IDENTITY_COMPLETION_ENABLED === "true";
}

/** `businessId` and `userId` are the session's — never from the request. */
export async function confirmExistingLegalIdentity(
  businessId: number,
  userId: number
): Promise<LegalIdentityCompletionResult> {
  return tenantTx(businessId, async (tx) => {
    const profile = await tx.businessProfile.findUnique({
      where: { businessId },
      select: { billingTaxId: true, legalIdentityConfirmedAt: true },
    });
    if (profile && profile.legalIdentityConfirmedAt === null && profile.billingTaxId) {
      const canonical = authoritativeTaxId(profile.billingTaxId);
      if (canonical !== null && canonical !== profile.billingTaxId) {
        await tx.businessProfile.update({ where: { businessId }, data: { billingTaxId: canonical }, select: { id: true } });
      }
    }
    const rows = await tx.$queryRaw<{ r: string }[]>`SELECT public.legal_identity_confirm_existing(${userId}::integer) AS r`;
    const r = rows[0]?.r;
    return (RESULTS as readonly string[]).includes(r ?? "") ? (r as LegalIdentityCompletionResult) : "NOT_ALLOWED";
  });
}
