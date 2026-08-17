/**
 * Business Memory IMPL-3 · Derived Claim Candidate — OUTPUT CONTRACT (pure types).
 *
 * The pure output of the Memory Deriver: what a derivation PRODUCES, before any persistence. This is
 * NOT a stored Claim — there is no DB id, no materializedAt, no owner-approval, no recommendation, no
 * global flag, no confidence. It reflects the ratified Claim strategy
 * (docs/business-brain-memory-claim-preimplementation-v1.md §19): a hybrid envelope + typed
 * proposition + candidate-set conflict model where STATE is a function of the candidate rowset.
 *
 * Source of truth:
 *   docs/business-brain-evidence-memory-contract-v1.md  (INV-6/7/8/9/10/13/17)
 *   docs/business-brain-memory-architecture-v1.md        (§5 Claim; §6 states)
 *   docs/business-brain-memory-claim-preimplementation-v1.md (§7 state=f(rowset); §8 candidate-set)
 *
 * Imports ONLY types from the Evidence Adapter public contract — never Prisma, never a store shape.
 */
import type { DomainLocalSubject, EvidenceRef, EvidenceSetIdentity } from "@/lib/business-memory/evidence";

/** The one claim kind in v1. The envelope is generic; the proposition value is typed per kind. */
export type ClaimType = "vendor-category";

/**
 * Derived state — a pure FUNCTION OF THE CANDIDATE ROWSET, never a stored status machine:
 *  - insufficient : no admissible evidence supports any proposition (also the empty-evidence case).
 *  - supported    : exactly one candidate proposition.
 *  - conflicting  : two or more incompatible candidate propositions (no winner is picked).
 *  - withdrawn    : evidence that HAD supported candidates was erased/invalidated, collapsing them
 *                   (distinct from insufficient only because erasure is known to have caused it).
 * There is deliberately NO `active/current/latest/preferred` state (INV-8).
 */
export type DerivedClaimState = "insufficient" | "supported" | "conflicting" | "withdrawn";

/**
 * One candidate proposition the evidence supports for a subject. It is NOT a winner and NOT a
 * decision. `supportingRefs` are the evidence records that back it (explanation linkage, INV-10) —
 * references only, never copied payload (INV-13). `supportingRefs.length` is a support COUNT usable as
 * an explanation input; it is NOT confidence and NOT authority (Claim pre-impl §10, INV-7).
 */
export interface DerivedClaimCandidate {
  readonly claimType: ClaimType;
  /** The typed proposition value — for vendor-category, the owner-final category string. */
  readonly propositionValue: string;
  /** Evidence records supporting this candidate, in the adapter's canonical order. */
  readonly supportingRefs: readonly EvidenceRef[];
}

/**
 * The full result of deriving Business Memory for ONE subject under ONE pinned policy version. A
 * rebuildable projection — not persisted, not authoritative. `evidenceSetIdentity` is the identity of
 * the evidence set that was read (for replay/explanation); `policyVersionId` is the explicitly pinned
 * DerivationPolicyVersion id (INV-2). No confidence, no winner, no persistence fields.
 */
export interface DerivedClaimResult {
  readonly subject: DomainLocalSubject;
  readonly claimType: ClaimType;
  /** The explicitly pinned DerivationPolicyVersion.id this derivation ran under (INV-2). */
  readonly policyVersionId: number;
  /** Identity of the owner-decision evidence set read (replay/explain anchor). */
  readonly evidenceSetIdentity: EvidenceSetIdentity;
  readonly state: DerivedClaimState;
  /** Candidate propositions. Empty for `insufficient` and `withdrawn`; 1 for `supported`; ≥2 for `conflicting`. */
  readonly candidates: readonly DerivedClaimCandidate[];
}

/** Optional, caller-supplied derivation inputs. `erasedRefs` is a CONTRACT/TEST-level erasure marker —
 *  it wires NO runtime erasure; it lets the deriver produce `withdrawn` deterministically (Claim pre-impl §8). */
export interface DeriveOptions {
  readonly erasedRefs?: readonly EvidenceRef[];
}
