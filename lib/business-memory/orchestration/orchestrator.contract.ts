/**
 * Business Memory IMPL-6A · Single-Pass Orchestrator — CONTRACT (types + injectable deps).
 *
 * Sequences Evidence Adapter → Policy Resolver → Memory Deriver → Claim Writer for ONE vendor-category
 * subject, with a best-effort (G1) double-read freshness check and S1 stale handling (abort+return, no
 * retry). Owns tenant/subject construction, sequencing, freshness, and the governed policy binding. It
 * defines no derivation semantics, picks no winner, computes no confidence, and never reads/writes
 * VendorLearning. Inert: no product trigger.
 *
 * All four collaborators are injected (default: the real components) so the Orchestrator is unit-
 * testable with fakes + call counting. No Prisma type leaks here.
 */
import type { DomainLocalSubject, OwnerDecisionEvidenceSet } from "@/lib/business-memory/evidence";
import type { DerivedClaimResult } from "@/lib/business-memory/derivation";
import type { ResolvedPolicyVersion } from "@/lib/business-memory/policy";
import type { MaterializationCommand, MaterializationOutcome } from "@/lib/business-memory/materialization";

/** Public input — trusted tenant + the raw vendor identity used to build the subject. NO policyVersionId,
 *  NO PolicyDescriptor, NO DerivedClaimResult, NO client-controlled tenant (§3). */
export interface OrchestratorInput {
  readonly businessId: number;
  readonly vendorInput: string | null;
}

/** The stage at which a typed failure occurred (surfaced, never swallowed — §16). */
export type OrchestratorFailureStage =
  | "tenant-subject"
  | "policy-resolution"
  | "evidence-read-first"
  | "evidence-read-second"
  | "derivation"
  | "writer-validation"
  | "writer-error";

export interface OrchestratorPolicyIdentity {
  readonly policyKey: string;
  readonly versionLabel: string;
  readonly policyVersionId: number;
}

/**
 * The operational outcome. A discriminated union — no truth/confidence/recommendation language.
 * `stale` carries both fingerprints for diagnostics; `failed` carries the stage + message (surfaced).
 */
export type OrchestratorOutcome =
  | {
      readonly kind: "materialized" | "deleted" | "no-op";
      readonly writerAction: MaterializationOutcome["action"];
      readonly candidateCount: number;
      readonly evidenceFingerprint: string;
      readonly policyIdentity: OrchestratorPolicyIdentity;
    }
  | {
      readonly kind: "stale";
      readonly evidenceFingerprintFirst: string;
      readonly evidenceFingerprintSecond: string;
      readonly policyIdentity: OrchestratorPolicyIdentity;
    }
  | {
      readonly kind: "failed";
      readonly stage: OrchestratorFailureStage;
      readonly message: string;
    };

/** The four injected collaborators. Defaults bind the real merged components. */
export interface OrchestratorDeps {
  resolvePolicyVersion(): Promise<ResolvedPolicyVersion>;
  readOwnerDecisionEvidence(businessId: number, subject: DomainLocalSubject): Promise<OwnerDecisionEvidenceSet>;
  deriveClaim(evidenceSet: OwnerDecisionEvidenceSet, policyVersionId: number): DerivedClaimResult;
  writeClaim(command: MaterializationCommand): Promise<MaterializationOutcome>;
}
