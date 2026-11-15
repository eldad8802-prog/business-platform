/**
 * The business kind chosen at signup (עוסק פטור / עוסק מורשה / חברה בע״מ), seeded into
 * BusinessProfile.billingBusinessKind right after the account commits.
 *
 * A SEED, not the issuer declaration (billing confirms that separately before the first issuance, and the
 * declared kind is locked there). So:
 *   - written only when the profile has no kind yet — never over an existing value, whoever set it;
 *   - written by the tenant runtime under the business's own context (tenantTx): the signup plane (app_auth)
 *     holds nothing on BusinessProfile and does not need to;
 *   - never fails the signup. On any error the account stands without a kind, and billing's identity form
 *     asks for it as it does today for every business that has none.
 *
 * `businessId` is the account just created — server-derived, never from the request.
 */

import { Prisma } from "@prisma/client";

import type { SignupBusinessKind } from "@/lib/auth/signup-identity";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type SeedBusinessKindOutcome = "seeded" | "kept" | "failed";

export async function seedSignupBusinessKind(businessId: number, kind: SignupBusinessKind): Promise<SeedBusinessKindOutcome> {
  // Two attempts: a profile created concurrently (setup) makes the create lose on the unique businessId
  // (P2002); the second attempt then only fills it if it still has no kind.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await tenantTx(businessId, async (tx) => {
        // Only a profile with no kind is filled: one conditional statement, so a writer that set a kind
        // first is never overwritten.
        const filled = await tx.businessProfile.updateMany({
          where: { businessId, billingBusinessKind: null },
          data: { billingBusinessKind: kind },
        });
        if (filled.count === 1) return "seeded";
        const existing = await tx.businessProfile.findUnique({ where: { businessId }, select: { id: true } });
        if (existing) return "kept";
        await tx.businessProfile.create({ data: { businessId, billingBusinessKind: kind }, select: { id: true } });
        return "seeded";
      });
    } catch (error) {
      if (attempt === 1 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      console.error("[signup] business_kind_seed_failed", { error: error instanceof Error ? error.name : "unknown" });
      return "failed";
    }
  }
  return "failed";
}
