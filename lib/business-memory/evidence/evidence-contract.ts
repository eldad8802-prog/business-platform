/**
 * Business Memory IMPL-2 · Evidence Reference / Adapter — CONTRACT (pure types + read interfaces).
 *
 * Source of truth:
 *   docs/business-brain-evidence-memory-contract-v1.md        (RATIFIED — INV-4/9/10/13/17)
 *   docs/business-brain-memory-architecture-v1.md             (§4 Evidence Reader; §5 Claim; §10 Subject)
 *   docs/business-brain-memory-persistence-design-v1.md       (§10 evidence-link; §11 subject; §18 P1+P4 adapter)
 *   docs/business-brain-memory-impl-2-preimplementation-v1.md (verdict B; §17 the five faces)
 *
 * WHAT THIS IS: a read-only boundary that isolates Business Memory from the PHYSICAL shape of the
 * canonical evidence (today `ReviewEvent`). It defines a stable, tenant-safe, explainable EVIDENCE
 * IDENTITY and a read interface. It DERIVES NOTHING: no Claim, no confidence, no policy, no
 * precedence, no "winning"/"latest"/"current" category. A future Derivation Policy interprets the
 * returned evidence sequence; this layer only surfaces it.
 *
 * WHAT THIS IS NOT: not persistence (no Prisma/table/migration here), not a writer, not a learned-
 * knowledge store, not an activation. This file has ZERO imports — it must never leak a Prisma type,
 * a DB column name, or a store-specific JSON shape (INV-10/13; IMPL-2 §10 store-swap test).
 */

// ── Authority (typed so owner-decision and engine-belief can never be conflated) ─────────────────
/**
 * Two — and only two — evidence authorities. `owner-decision` is AUTHORITATIVE (the learning signal);
 * `engine-belief` is NON-AUTHORITATIVE context/explanation. They are distinct discriminated types
 * below; no function that wants an OwnerDecisionEvidence will structurally accept an
 * EngineBeliefEvidence without an explicit, visible conversion (there is none).
 */
export type EvidenceAuthority = "owner-decision" | "engine-belief";

/** The physical evidence source a reference points at. The ONLY place a source is named. */
export type EvidenceKind = "review-event" | "extraction-snapshot";

// ── Stable logical reference (never carries raw payload) ─────────────────────────────────────────
/**
 * A stable, store-agnostic pointer to ONE canonical evidence record. Business Memory dereferences
 * this to explain a derivation (INV-10); it never copies raw evidence into it (INV-13). If the
 * canonical store is later swapped (unified log / C0), only `kind` + the mapper change — consumers
 * keep using `EvidenceRef`.
 */
export interface EvidenceRef {
  readonly kind: EvidenceKind;
  /** Tenant scope carried on the reference itself — no cross-tenant reference is representable. */
  readonly businessId: number;
  /** Identity of the underlying canonical record within its store (append-only; stable). */
  readonly recordId: number;
}

// ── Domain-local subject (minimal identity — NOT a generic ontology, NOT a SubjectRef table) ─────
/**
 * The subject a piece of learned knowledge is about, in its DOMAIN-LOCAL form (Architecture §10.A;
 * IMPL-2 §11). For v1 the only domain is the vendor. This is a minimal identity contract — a typed
 * {domain, normalizedKey, businessId}, deliberately NOT an arbitrary bare string and NOT a generic
 * predicate/subject ontology. It is designed so a future RIA canonical referent can be bound as an
 * alias over the SAME evidence WITHOUT rewriting anything (IMPL-2 §12) — but it imports/activates no RIA.
 */
export type SubjectDomain = "vendor";
export interface DomainLocalSubject {
  readonly domain: SubjectDomain;
  /** Canonical grouping key within the domain+tenant (e.g. normalized vendor key). */
  readonly normalizedKey: string;
  readonly businessId: number;
}

// ── Field readout (owner-final vs engine-belief), authority-tagged, NOT a decision ───────────────
/** How the owner acted on one field at approve time. Mirrors the canonical ledger verdict vocabulary. */
export type FieldVerdict = "confirmed" | "corrected" | "rejected" | "not-submitted";

/**
 * One owner-decision evidence item (one approve event). It carries the owner-FINAL readouts as data
 * — it is NOT itself a decision about the subject, and it asserts no "winning" value. `occurredAt`
 * (ISO-8601) + `ordinal` give a deterministic, append-only order; a future policy reads the sequence.
 */
export interface OwnerDecisionEvidence {
  readonly authority: "owner-decision";
  readonly ref: EvidenceRef;
  readonly businessId: number;
  /** The subject this owner decision is about (domain-local). */
  readonly subject: DomainLocalSubject;
  /** Authoritative temporal field: when the owner decided (ISO-8601 string; no Date leak). */
  readonly occurredAt: string;
  /** Total-order tiebreaker for equal `occurredAt` — the append-only record id. NOT precedence. */
  readonly ordinal: number;
  /** Owner-final field readouts (raw values as confirmed by the human). Interpretation is the policy's job. */
  readonly ownerFinal: {
    readonly vendor: string | null;
    readonly category: string | null;
    readonly direction: string | null;
  };
  /** Per-field verdict for this event (confirmed/corrected/rejected/not-submitted). Context, not authority. */
  readonly verdicts: {
    readonly vendor: FieldVerdict;
    readonly category: FieldVerdict;
    readonly direction: FieldVerdict;
  };
}

/**
 * One engine-belief evidence item (extraction time). NON-AUTHORITATIVE context/explanation only.
 * A distinct type from OwnerDecisionEvidence on purpose: it can never stand in for an owner decision.
 */
export interface EngineBeliefEvidence {
  readonly authority: "engine-belief";
  readonly ref: EvidenceRef;
  readonly businessId: number;
  readonly occurredAt: string;
  readonly ordinal: number;
  /** Raw engine belief at extraction (no entity resolution, no normalization). */
  readonly belief: {
    readonly vendor: string | null;
    readonly category: string | null;
    readonly direction: string | null;
  };
}

// ── Evidence-set identity (deterministic; a fingerprint, NOT an authority) ────────────────────────
/**
 * The deterministic identity of the evidence set a derivation read (IMPL-2 §17.C). It is the ordered
 * list of `EvidenceRef`s plus the canonical ordering rule. `fingerprint` is a convenience digest of
 * those refs for cheap equality — explicitly a FINGERPRINT, never authority and never the source of
 * truth (the refs are). Two reads over the same underlying canonical state yield the same identity.
 */
export interface EvidenceSetIdentity {
  readonly refs: readonly EvidenceRef[];
  /** The single canonical ordering this layer guarantees (see IMPL-2 §9). */
  readonly ordering: "occurredAt-asc,ordinal-asc";
  /** Convenience digest of `refs` — a fingerprint for equality only, NOT authority. */
  readonly fingerprint: string;
}

/** A tenant-scoped, subject-scoped, deterministically-ordered set of owner-decision evidence. */
export interface OwnerDecisionEvidenceSet {
  readonly subject: DomainLocalSubject;
  readonly items: readonly OwnerDecisionEvidence[];
  readonly identity: EvidenceSetIdentity;
}

// ── Read interfaces (owner-decision and engine-belief are SEPARATE APIs — IMPL-2 §13) ────────────
/**
 * The authoritative reader. Tenant (`businessId`) comes from the CALL CONTEXT, never from a client
 * payload. Returns the append-only owner-decision evidence for a domain-local subject, deterministically
 * ordered, with a stable identity. It performs NO derivation, NO dedup heuristic, NO "latest"/"winner"
 * selection — it preserves evidence (IMPL-2 §6/§8). An empty set means "no evidence" — never approval,
 * rejection, or a default (INV-4; IMPL-2 §7).
 */
export interface OwnerDecisionEvidenceReader {
  readOwnerDecisionEvidence(
    businessId: number,
    subject: DomainLocalSubject,
  ): Promise<OwnerDecisionEvidenceSet>;
}

/**
 * The NON-AUTHORITATIVE context reader — deliberately a separate interface so engine belief is never
 * mixed into the owner-decision evidence list without an explicit, visible call (IMPL-2 §13).
 */
export interface EngineBeliefEvidenceReader {
  readEngineBeliefContext(
    businessId: number,
    documentId: number,
  ): Promise<readonly EngineBeliefEvidence[]>;
}
