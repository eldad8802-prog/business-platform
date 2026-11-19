/**
 * Write the legal identity INSIDE the signup account transaction (migration 20261128090000_signup_legal_identity).
 *
 * The auth plane holds nothing on BusinessProfile. It calls signup_legal_identity_seed, a definer function that
 * writes the profile ONLY for the business the current transaction created, and marks it confirmed (SIGNUP), which
 * locks kind / legal name / tax id from then on (BusinessProfile_legal_identity_lock). Because it runs in the same
 * transaction as Business and User, the account and its identity commit together or not at all: a failure here
 * rolls the whole signup back, and there is no "account without identity" state to gate or to bypass.
 *
 * The values were validated by normalizeLegalIdentity; the function validates them again as the backstop. Its
 * errors name a field (DETAIL), never a value; they are reported as LegalIdentityRejectedError without the value.
 */

import { Prisma } from "@prisma/client";

import type { NormalizedLegalIdentity } from "./signup-legal-identity";

/** The database refused the identity. Carries the field it named, never the value. */
export class LegalIdentityRejectedError extends Error {
  readonly field: string | null;
  constructor(field: string | null) {
    super("legal_identity_rejected");
    this.name = "LegalIdentityRejectedError";
    this.field = field;
  }
}

export async function seedLegalIdentityInAccountTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  identity: NormalizedLegalIdentity
): Promise<void> {
  try {
    await tx.$executeRaw`SELECT public.signup_legal_identity_seed(
      ${businessId}::integer, ${identity.kind}, ${identity.legalName}, ${identity.taxId},
      ${identity.address}, ${identity.phone}, ${identity.businessEmail})`;
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    if (/DZL02|LEGAL_IDENTITY_INVALID/.test(text)) {
      const field = /DETAIL:\s*(\w+)|"detail":\s*"(\w+)"/.exec(text);
      throw new LegalIdentityRejectedError(field ? (field[1] ?? field[2] ?? null) : null);
    }
    throw error;
  }
}
