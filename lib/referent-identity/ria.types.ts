/**
 * Referent Identity Authority (RIA) — Minimum Cross-Feature Executable Proof.
 *
 * PROOF-ONLY, NON-NORMATIVE. These shapes realize the RATIFIED RIA-1 contract
 * (§0–§7, in-conversation) for a fixtures-only Governance→Runtime validation. They
 * do NOT ratify a survivor / cluster / pointer / persistence architecture; every
 * encoding here is implementation-only and may be replaced without touching the
 * contract. No DB, no persistence, no product wiring, no production identity rules.
 *
 * Layer position: World → Observation → C0 (Evidence) → *RIA (Identity Authority)*
 * → Detection Grammar (consumes aligned identity) → … RIA sits POST-C0 and imports
 * C0 one-way; C0 never imports RIA (see ../business-brain). RIA only ASSERTS identity
 * relations from AUTHORIZED bases; it is not a matcher, ledger, or truth container.
 *
 * Ratified anchors realized here:
 *   • §1  SAME / DISTINCT / UNRESOLVED (healthy) + CONFLICT (state-health, derived).
 *   • §2  Authority Class ≠ Authorized Basis; RIA-only-asserts; verification ≠ authority.
 *   • §3  Assertion (immutable, append-only) vs State (derived); applicability derived.
 *   • §4  Canonical Referent = anchor (≠ truth container); anchors are preserved, never
 *         destroyed by reconciliation; a shared identity is a DERIVED equivalence-class.
 *   • §5  Identity Method Policy substrate (SAME / DISTINCT authorization separated).
 *   • §6  Dual-time: explicit recorded + effective time; explicit EvaluationTime, no
 *         wall-clock; deterministic historical reconstruction.
 *   • §7  Current Identity Interpretation (CII) = derived equivalence-class; DISTINCT
 *         constrains; contradiction → CONFLICT (abstain, NO graph-cut / partition).
 */

import type {
  ObservationAccountId,
  ReferentType,
  Tenant,
} from "../business-brain/observation.types";

// ── Canonical Referent anchor identity (§4) ───────────────────────────────────
//
// Opaque, immutable, tenant-scoped, never-reused. A Canonical Referent is an ANCHOR
// (a stable name for "a referent as some source sees it"), NOT a container of truth.
// In this proof anchors are PRE-MINTED fixtures (§9 of the audit): no Minting Runtime
// is exercised — minting is not part of the claim.
export type CanonicalReferentId = string & { readonly __brand: "CanonicalReferentId" };

export function canonicalReferentId(raw: string): CanonicalReferentId {
  return raw as CanonicalReferentId;
}

// ── Authority-capable fixture input (§2) ──────────────────────────────────────
//
// A FixtureAuthoritativeRef is an authority-capable INPUT — what a real system would
// obtain from an authoritative canonical / internal source (§2 Class-A). It is NOT a
// Canonical Referent, NOT a CII, NOT an Identity Assertion, NOT a finished result, and
// NOT feature-local identity authority. The Method Policy — and ONLY the Method Policy
// — is permitted to read it; the resolver and CII derivation never see it.
export type FixtureAuthoritativeRef = string & { readonly __brand: "FixtureAuthoritativeRef" };

export function fixtureAuthoritativeRef(raw: string): FixtureAuthoritativeRef {
  return raw as FixtureAuthoritativeRef;
}

// ── Source Referent Binding (§2 / §4 grounds) ─────────────────────────────────
//
// GROUNDS packaged from a C0 account + authority inputs. It carries NO resolution:
// it does not compare, infer, mint, or choose a canonical referent (see cot-to-binding).
// `canonicalReferentId` is the pre-minted anchor this binding is attached to (the
// source's own view); `authorityRef` is the authority-capable input the policy reads;
// `affirmativeDistinctFrom` is a SEPARATE, targeted, affirmative distinctness authority
// (anchor-keyed) — never derived from token mismatch (§2 / §7).
export interface SourceReferentBinding {
  readonly tenant: Tenant;
  readonly referentType: ReferentType;
  /** Provenance back to the immutable C0 account (never mutated). */
  readonly accountRef: ObservationAccountId;
  /** The pre-minted anchor (source's own canonical referent view). */
  readonly canonicalReferentId: CanonicalReferentId;
  /** Authority-capable input; POLICY-ONLY (resolver/derivation never read it). */
  readonly authorityRef: FixtureAuthoritativeRef;
  /** Affirmative, targeted distinctness authority (anchor-keyed). Optional. */
  readonly affirmativeDistinctFrom?: readonly CanonicalReferentId[];
}

// ── Identity relations (§1) ───────────────────────────────────────────────────
//
// The two ASSERTABLE relations. UNRESOLVED is the healthy absence of an authorized
// relation (no assertion is made); CONFLICT is a DERIVED state-health disposition, not
// an assertable relation and not a stored fourth outcome.
export type IdentityRelation = "SAME" | "DISTINCT";

// ── Authorized Basis (§2) ─────────────────────────────────────────────────────
//
// The typed authority OUTPUT of a Method Policy evaluation. Authority CLASS is not the
// basis; the basis is the concrete, justified authorization the policy produced. left/
// right are canonically ordered (sorted) so a symmetric relation has one identity.
export interface AuthorizedBasis {
  readonly relation: IdentityRelation;
  readonly left: CanonicalReferentId;
  readonly right: CanonicalReferentId;
  readonly tenant: Tenant;
  readonly referentType: ReferentType;
  readonly policyId: string;
  readonly policyVersion: string;
  /** Human-readable statement of WHAT authority grounded this basis. */
  readonly justification: string;
}

export type PolicyDecision =
  | { readonly kind: "AUTHORIZED"; readonly basis: AuthorizedBasis }
  | { readonly kind: "NO_AUTHORIZATION"; readonly reason: string };

// ── Identity Assertion (§3) — immutable, append-only ──────────────────────────
//
// An assertion is an immutable RECORD that an authorized basis was consumed at a point
// in dual-time. It is never edited; corrections are new appended assertions (not
// exercised in the main proof). `assertionId` is a deterministic content digest.
export interface IdentityAssertion {
  readonly assertionId: string;
  readonly relation: IdentityRelation;
  readonly left: CanonicalReferentId;
  readonly right: CanonicalReferentId;
  readonly tenant: Tenant;
  readonly referentType: ReferentType;
  readonly basis: AuthorizedBasis;
  /** §6 recorded-time: when RIA recorded the assertion (explicit; no wall-clock). */
  readonly recordedAt: string;
  /** §6 effective-time: when the assertion becomes effective (explicit; dual-time). */
  readonly effectiveAt: string;
}

/** §3 append-only history. Order is not authority (§6): applicability is derived. */
export type IdentityHistory = readonly IdentityAssertion[];

// ── Temporal Reconstruction Context (§6) ──────────────────────────────────────
//
// Explicit dual-time reconstruction inputs. An assertion is APPLICABLE iff it is known
// (recordedAt ≤ historyBoundary) AND effective (effectiveAt ≤ evaluationTime). No
// hidden wall-clock; replay pins exactly these two values.
export interface TemporalReconstructionContext {
  readonly evaluationTime: string;
  readonly historyBoundary: string;
}

// ── Current Identity Interpretation (§7) — DERIVED equivalence-class ───────────
//
// PROOF REPRESENTATION ONLY; does not ratify survivor / group / pointer / persistence
// architecture. `members` is the derived SAME-closure equivalence-class (canonically
// ordered for replay). `disposition` is derived state-health: RESOLVED (usable) or
// CONFLICT (an applicable DISTINCT contradicts the closure → abstain; members are NOT
// partitioned or cut — RC6).
export type CiiDisposition = "RESOLVED" | "CONFLICT";

export interface CurrentIdentityInterpretation {
  readonly tenant: Tenant;
  readonly referentType: ReferentType;
  readonly members: readonly CanonicalReferentId[];
  readonly disposition: CiiDisposition;
}
