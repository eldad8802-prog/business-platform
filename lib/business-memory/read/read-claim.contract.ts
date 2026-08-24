/**
 * Business Memory READ-2 (R1) · Claim Reader — CONTRACT (pure types).
 *
 * The typed surface of the tenant-scoped Claim Reader: a full-identity Projection lookup and a typed
 * result union. INERT / UNWIRED: no product code imports this yet; there is no coordinator, no staleness
 * check, no VendorLearning fallback, no env flag, no read-switch here (READ-1 activation plan).
 *
 * Deliberately absent from this contract: confidence, score, ranking, preferred, current/latest,
 * recommendation, truth/verified. Only `supported` carries a single category; `conflicting` returns the
 * whole candidate set and never picks a winner.
 */

/** Fully-specified claim identity. Every field is required — there is no subject-only / vendor-only form. */
export interface ReadClaimQuery {
  /** Trusted tenant, from server context — never a client payload. */
  readonly businessId: number;
  readonly subjectDomain: "vendor";
  /** Canonical normalized subject key (computed upstream via normalizeVendorForLearning). */
  readonly subjectNormalizedKey: string;
  readonly claimType: "vendor-category";
  /** The pinned DerivationPolicyVersion.id — resolved UPSTREAM (the reader is NOT a resolver). */
  readonly policyVersionId: number;
}

/**
 * Reader result. `stale` is intentionally NOT here: detecting staleness needs the CURRENT evidence set,
 * which is a coordinator concern (READ-1 PHASE 3 / S2), not an intrinsic property of the Projection.
 */
export type ReadClaimResult =
  | {
      readonly status: "supported";
      /** The single owner-supported category. ONLY this status carries a category. */
      readonly category: string;
      /** Count of supporting evidence links for the candidate — a support count, NOT a confidence/score. */
      readonly candidateRefCount: number;
      readonly evidenceSetFingerprint: string;
    }
  | {
      readonly status: "conflicting";
      /** All distinct candidate values. Deterministically ordered for STABLE OUTPUT ONLY — not precedence. */
      readonly candidates: readonly string[];
      readonly evidenceSetFingerprint: string;
    }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string };

/** One candidate row the reader reads (value + its supporting-evidence-link count). */
export interface ClaimReaderCandidateRow {
  readonly propositionValue: string;
  readonly _count: { readonly evidenceLinks: number };
}

/** The projection row shape the reader selects — references/counts only, no payload. */
export interface ClaimReaderProjectionRow {
  readonly evidenceSetFingerprint: string;
  readonly candidates: readonly ClaimReaderCandidateRow[];
}

/** The compound-unique selector for the 5-tuple identity (Prisma `@@unique` composite key). */
export interface ClaimIdentityWhere {
  readonly businessId_subjectDomain_subjectNormalizedKey_claimType_policyVersionId: {
    readonly businessId: number;
    readonly subjectDomain: string;
    readonly subjectNormalizedKey: string;
    readonly claimType: string;
    readonly policyVersionId: number;
  };
}

/**
 * The NARROW, READ-ONLY client surface the reader needs — exactly one `findUnique` on
 * DerivedClaimProjection by the compound-unique key. No write method is representable through this type,
 * so the reader is read-only BY CONSTRUCTION.
 */
export interface ClaimReaderClient {
  readonly derivedClaimProjection: {
    findUnique(args: {
      where: ClaimIdentityWhere;
      select: {
        evidenceSetFingerprint: true;
        candidates: { select: { propositionValue: true; _count: { select: { evidenceLinks: true } } } };
      };
    }): Promise<ClaimReaderProjectionRow | null>;
  };
}
