/**
 * Business Memory IMPL-5A · Derived Claim Persistence Writer — CONTRACT (types + narrow client).
 *
 * The Writer persists ONE already-derived, already-identified DerivedClaimResult into exactly one
 * materialized projection slot, atomically. It is the narrow W-A persistence writer (Materializer
 * pre-impl v1 §16/§23): it does NOT read evidence, derive, resolve/select a policy, normalize, or touch
 * VendorLearning. Freshness of the supplied result is an UPSTREAM Orchestrator responsibility (§15).
 *
 * This file defines the internal command, the operational outcome, and a NARROW structural client
 * interface (a subset of Prisma) so the Writer is unit-testable with an injected fake — no real DB and
 * no Prisma type leak into the contract.
 */
import type { DerivedClaimResult } from "@/lib/business-memory/derivation";

/**
 * The internal, server-trusted command. `businessId` is the trusted tenant from a future server-side
 * caller — NEVER derived from a client payload. The Writer requires
 * `result.subject.businessId === businessId` (§3/§6).
 */
export interface MaterializationCommand {
  readonly businessId: number;
  readonly result: DerivedClaimResult;
}

/** What the Writer did. NOT a recommendation, NOT truth, NOT confidence. */
export type MaterializationAction = "created" | "replaced" | "deleted" | "no-op";

export interface MaterializationOutcome {
  readonly action: MaterializationAction;
  readonly slot: {
    readonly businessId: number;
    readonly subjectDomain: string;
    readonly subjectNormalizedKey: string;
    readonly claimType: string;
    readonly policyVersionId: number;
  };
  readonly evidenceSetFingerprint: string;
  readonly candidateCount: number;
  readonly evidenceLinkCount: number;
}

// ── Narrow client interface (a structural subset of Prisma) ──────────────────────────────────────
/** The transaction-scoped operations the Writer needs. Deliberately minimal — read-existence, delete
 *  the slot (cascade removes children), and a nested create of Projection+Candidates+EvidenceLinks. */
export interface ClaimWriterTx {
  derivationPolicyVersion: {
    findUnique(args: { where: { id: number }; select: { id: true } }): Promise<{ id: number } | null>;
  };
  derivedClaimProjection: {
    deleteMany(args: { where: ProjectionSlotWhere }): Promise<{ count: number }>;
    create(args: { data: ProjectionCreateData }): Promise<{ id: number }>;
  };
}
export interface ClaimWriterClient {
  $transaction<T>(fn: (tx: ClaimWriterTx) => Promise<T>): Promise<T>;
}

/** The 5-field slot identity (the approved projection uniqueness — Claim persistence v2 §12). */
export interface ProjectionSlotWhere {
  businessId: number;
  subjectDomain: string;
  subjectNormalizedKey: string;
  claimType: string;
  policyVersionId: number;
}

/** Nested-create shape for a projection + its candidates + their evidence links (one atomic write). */
export interface ProjectionCreateData {
  businessId: number;
  subjectDomain: string;
  subjectNormalizedKey: string;
  claimType: string;
  policyVersionId: number;
  evidenceSetFingerprint: string;
  candidates: {
    create: Array<{
      propositionValue: string;
      evidenceLinks: {
        create: Array<{ businessId: number; evidenceKind: string; evidenceRecordId: number }>;
      };
    }>;
  };
}
