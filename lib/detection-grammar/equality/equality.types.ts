/**
 * Detection Grammar — C1 (Runtime) · Equality Operator · Minimum Executable Proof.
 *
 * Primitive Operator #6 — Canonical Relation Evaluation.
 * Ratified contract: Equality/contract@v1-2026-08-11 (§N of the Detection Grammar
 * PART B governance corpus, origin/main). This module holds ONLY the shapes the
 * ratified §N commitments dictate for a fixtures-only proof — no persistence, no
 * lifecycle, no DB ids, no future-oriented schema.
 *
 * Layer position (business-brain/observation.types.ts:5): World → Observation →
 * C0 → *Detection Grammar* → Forms → … A Detection-Grammar operator emits a
 * Projection ABOVE Evidence and BELOW Belief. This operator emits neither Evidence
 * nor Belief, and never a Judgment.
 */
import type { ObservationAccountId } from "../../business-brain/observation.types";

/** Equality operator Contract Version (operator-owned authority; ED4). */
export const EQUALITY_CONTRACT_VERSION = "Equality/contract@v1-2026-08-11";

/** EC1 — the ONLY successful Outcome values. No third state; no payload. */
export type EqualityOutcome = "EQUAL" | "NOT_EQUAL";

/** EE1 — the four failure families. */
export type FailureFamily = "A" | "B" | "C" | "D";

/** Who classified the failure. Family A is Equality-owned; B/C/D are consumed from
 *  an authoritative source and never invented by Equality (EE2). */
export type FailureSource = "EQUALITY" | "DOMAIN" | "EXECUTION" | "SUPERVISOR";

/** EE1/EE2 — a Failure is a non-Outcome category. It is never `NOT_EQUAL`. */
export interface EqualityFailure {
  readonly kind: "FAILURE";
  readonly family: FailureFamily;
  /** EE2 — a disposition may be valid without a resolved classification. */
  readonly classified: boolean;
  readonly source: FailureSource;
  readonly detail: string;
}

/** EC1 — a successful terminal disposition carries the pure Outcome value only. */
export interface EqualityOutcomeDisposition {
  readonly kind: "OUTCOME";
  readonly outcome: EqualityOutcome;
}

/** EC2 — a terminal disposition is Outcome XOR Failure: exactly one, never both,
 *  never neither. */
export type Disposition = EqualityOutcomeDisposition | EqualityFailure;

/** A Domain-owned canonical value witness (EB4 — canonicalization is Domain-owned
 *  and Equality-agnostic; Equality never defines it). Opaque to the operator. */
export interface AdmittedValue {
  readonly witness: string;
}

/** A relatum already admitted upstream under an explicit Domain binding (EB3 —
 *  admissibility is an upstream precondition the operator consumes). */
export interface Relatum {
  readonly domainId: string;
  readonly domainVersion: string;
  readonly value: AdmittedValue;
  /** ED1 — the stable positional reference of this relatum participation. This is
   *  the C0 account identity, NOT the resolved value (value-resolved identity is
   *  excluded). */
  readonly accountRef: ObservationAccountId;
}

/** ED4 — a complete Operation specification includes at least the Contract Version,
 *  Domain ID, Domain Version, and the ordered relata references. ED1 — ordered and
 *  orientation-preserving: [a,b] and [b,a] are distinct Operations. */
export interface OperationSpec {
  readonly contractVersion: string;
  readonly domainId: string;
  readonly domainVersion: string;
  readonly orderedRelatumRefs: readonly [ObservationAccountId, ObservationAccountId];
}

/** ED1 defers the concrete hashing / replay-key mechanism; this digest is a
 *  proof-local convenience, NOT a canonical governance rule. */
export type OperationIdentityDigest = string & { readonly __brand: "OperationIdentityDigest" };

/**
 * ED2 — the Result Record. The four layers stay distinct and never collapse:
 * Operation specification, Evaluation attempt, Terminal disposition, Result record.
 * This object is the Detection-Grammar Projection (the operator OUTPUT/value). It is
 * computed and non-persistent; it holds no lifecycle, storage, or status machine.
 */
export interface EqualityProjection {
  readonly operationSpec: OperationSpec;
  readonly operationIdentityDigest: OperationIdentityDigest;
  readonly disposition: Disposition;
  readonly provenance: {
    readonly operatorContractVersion: string;
    readonly relatumAccountRefs: readonly [ObservationAccountId, ObservationAccountId];
  };
}
