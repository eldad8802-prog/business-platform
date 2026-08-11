/**
 * Father Engine — C0 (Canonical Observation Model / COT).
 *
 * The entry point of the whole pipeline:
 *   World → Observation → C0 → Detection Grammar → Forms → Observability Ontology
 *        → Phenomenon-Belief → Judgment → Owner Output
 *
 * A CanonicalObservation is an IMMUTABLE, APPEND-ONLY Evidence atom. Locked
 * contracts realized here (see the C0 v1.2 Delta Reports):
 *
 *   • Immutable Account: one observationAccountId → one canonicalHash → one
 *     ExecutionContext, forever. It never mutates. C0 never "supersedes".
 *   • Logical Source vs Account: one sourceObservationId (a source slot in the
 *     world) may have MANY append-only sibling Accounts. Which one wins / is
 *     current / feeds Belief is decided by LATER layers, never by C0.
 *   • Account = the observation/inference ACT, not the semantic value. Two
 *     inference runs with the same output are two distinct Accounts (runId lives
 *     in InferenceSubstrate, inside the content that canonicalHash covers).
 *   • Grounds vs computed: this record carries only GROUNDS (provenance,
 *     completeness, coverage, confidence basis). Confidence numbers, ceilings,
 *     and "who wins" are computed downstream by versioned policies — never stored
 *     here, so a policy change never reinterprets a historical COT.
 *   • Missing ≠ negative; Unknown is a legitimate, first-class value.
 *
 * Identity fields are DERIVED — never hand-authored. Build an ObservationContent
 * and call sealObservation() (observation-identity.ts) to obtain a COT.
 */

import type {
  ConceptId,
  ConceptVersion,
  CotSchemaVersion,
  EngineEpochId,
  ExecutionPolicyVersion,
  ReferentSubtype,
  RegistrySnapshotDigest,
  TranslatorName,
  TranslatorVersionTag,
} from "./versioning.types";
import type { Coverage } from "./coverage.types";

// ── Identity (branded strings; content-derived, see observation-identity.ts) ──

/** Logical Source Identity — "which source slot in the world". Stable across
 *  content, context, epoch and translator-version changes. */
export type SourceObservationId = string & { readonly __brand: "SourceObservationId" };

/** Immutable Account Identity — this exact, frozen observation act. Any change to
 *  content or ExecutionContext yields a DIFFERENT account (a sibling), never a
 *  mutation of this one. */
export type ObservationAccountId = string & { readonly __brand: "ObservationAccountId" };

/** Content fingerprint of a sealed account. Branded so it can never be mixed with
 *  an arbitrary string or swapped into an id position. */
export type CanonicalHash = string & { readonly __brand: "CanonicalHash" };

// ── Measurement primitives (CLOSED axes — the only atoms) ─────────────────────

/** The 4 computational primitives, as 5 scales (interval/ratio distinguished). */
export type Scale = "NOMINAL" | "ORDINAL" | "INTERVAL" | "RATIO" | "CARDINAL";

/** How the observation relates to time. */
export type Mode = "EVENT" | "STATE" | "MEASURE";

export interface Value {
  scale: Scale;
  /** The canonical datum. null is a legitimate value only alongside Completeness. */
  datum: string | number | boolean | null;
  /** Unit dimension token; null for unitless scales (NOMINAL/ORDINAL/CARDINAL). */
  unit: string | null;
}

// ── World vocabulary (Kind = world concept, NOT feature) ──────────────────────

/** A pinned world-concept reference. conceptVersion MUST exist in the
 *  ExecutionContext's conceptRegistrySnapshot (validated during Normalize). */
export interface BusinessConceptVersion {
  conceptId: ConceptId;
  conceptVersion: ConceptVersion;
}

// ── Referent + Identity binding (Reality-Graph anchor) ────────────────────────

export type ReferentType = "PARTY" | "COMMITMENT" | "RESOURCE";

export type ResolutionMethod = "DETERMINISTIC_EXACT" | "SELF_ANCHOR";

/** Reason an identity / time / completeness value is not known. Honest, not a
 *  threshold — these are epistemic states, not tuned parameters. */
export type UnknownReason =
  | "NOT_OBSERVED"
  | "NOT_COVERED"
  | "UNRESOLVED_IDENTITY"
  | "AMBIGUOUS"
  | "SOURCE_SILENT";

/** Identity binding as independent unions. Only a RESOLVED binding is eligible
 *  for the Identity-Join grammar operator — SIGNAL_ONLY / UNRESOLVED are not. */
export type IdentityBinding =
  | {
      kind: "RESOLVED";
      entityType: string;
      entityId: number;
      resolutionMethod: ResolutionMethod;
    }
  | { kind: "SIGNAL_ONLY"; signalType: string; signalValue: string }
  | { kind: "UNRESOLVED"; reason: UnknownReason };

export interface Referent {
  referentType: ReferentType;
  referentSubtype?: ReferentSubtype;
  identityBinding: IdentityBinding;
}

// ── Non-causal cross-references (never a causal claim) ────────────────────────

/** A reference to a related observation. NON-causal — records adjacency, not
 *  causation (Lead-Lag / Coupling are non-causal by contract). */
export interface CauseRef {
  relatedSourceObservationId?: SourceObservationId;
  note?: string;
}

export interface ProcessInstanceRef {
  processType: string;
  instanceId: string;
}

// ── Time (event vs observation; no silent fallback — see D7) ──────────────────

/** The semantic clock. When UNKNOWN, downstream operators must NOT silently fall
 *  back to observationTime; any fallback is tagged temporalBasis at the operator
 *  (Projection) layer, never baked into the COT. */
export type EventTime =
  | { kind: "INSTANT"; at: string }
  | { kind: "INTERVAL"; from: string; to: string }
  | { kind: "UNKNOWN"; reason: UnknownReason };

/** When WE sensed it — always known. */
export interface ObservationTime {
  at: string;
}

// ── Provenance (grounds; provenance = ceiling is computed by policy, not here) ─

/** Reality tier token. The 8-tier vocabulary is owned by the Evidence & Reality
 *  Constitution and will be pinned as a registry in a later PR; kept as an opaque
 *  provenance-bearing token here so C0 neither invents nor freezes that vocabulary. */
export type RealityTier = string;

export type Authentication =
  | "AUTHENTICATED"
  | "SELF_ASSERTED"
  | "THIRD_PARTY"
  | "UNKNOWN";

/** Present iff an inference engine (OCR/LLM/…) produced this observation. runId is
 *  IDENTITY-BEARING: a distinct inference run is a distinct Account, even with an
 *  identical output. Agreement between two such Accounts is information for the
 *  Belief/Conflict/Aggregation layer — never an Evidence-level dedup. */
export interface InferenceSubstrate {
  engine: string;
  engineVersion: string;
  runId: string;
  nonDeterministic: boolean;
}

/** Per-field origin — guards against channel-laundering (a low-tier field being
 *  presented under a high-tier record's provenance). */
export interface FieldProvenance {
  field: string;
  realityTier: RealityTier;
  channel: string;
}

export interface Provenance {
  realityTier: RealityTier;
  authentication: Authentication;
  channel: string;
  inference?: InferenceSubstrate;
  fieldProvenance?: FieldProvenance[];
}

// ── Completeness + Coverage (grounds) ─────────────────────────────────────────

/** What is present/missing in THIS observation (grounds, not a score). */
export type Completeness =
  | { kind: "COMPLETE" }
  | { kind: "PARTIAL"; missing: string[] }
  | { kind: "UNKNOWN"; reason: UnknownReason };

/** Coverage grounds are shared (see coverage.types.ts). The Observability
 *  Ontology's T1/T2/T3 detectability class is a DIFFERENT axis, derived later —
 *  it is deliberately not carried in the COT. */
export type { Coverage } from "./coverage.types";

// ── Confidence BASIS (grounds only — no computed values; see v1.1) ────────────

export interface FreshnessBasis {
  asOf: string;
  halfLifeSeconds?: number;
}

/** GROUNDS for confidence, never a confidence number. Ceiling / coverageImpact /
 *  total are computed by a versioned ConfidencePolicy downstream, not stored. */
export interface ConfidenceBasis {
  freshness?: FreshnessBasis;
  directionalBias?: "low" | "high";
  sourceAssertedConfidence?: number;
}

// ── Execution Context (the pinned run identity) ───────────────────────────────

export interface EngineEpoch {
  epochId: EngineEpochId;
}

export interface TranslatorVersion {
  /** STABLE name — a source-identity input (version-independent). */
  translatorName: TranslatorName;
  /** Content-affecting version — part of canonicalHash, not sourceObservationId. */
  version: TranslatorVersionTag;
}

export interface ExecutionContext {
  engineEpoch: EngineEpoch;
  cotSchemaVersion: CotSchemaVersion;
  translatorVersion: TranslatorVersion;
  conceptRegistrySnapshot: RegistrySnapshotDigest;
  executionPolicyVersion: ExecutionPolicyVersion;
}

// ── Source anchor + tenant (inputs to sourceObservationId) ────────────────────

export interface Tenant {
  businessId: number;
}

export interface SourceAnchor {
  featureDomain: string;
  sourceModel: string;
  sourceRecordId: string;
  /** Fan-out discriminator: the i-th observation a translator emits from one
   *  source record. Distinct index → distinct sourceObservationId. */
  emittedObservationIndex: number;
}

// ── The Canonical Observation (COT) ───────────────────────────────────────────

export interface CanonicalObservation {
  // Derived identity — never hand-authored (see sealObservation).
  readonly sourceObservationId: SourceObservationId;
  readonly observationAccountId: ObservationAccountId;
  readonly canonicalHash: CanonicalHash;

  // Source anchor (inputs to sourceObservationId).
  readonly tenant: Tenant;
  readonly source: SourceAnchor;

  // Content.
  readonly concept: BusinessConceptVersion;
  readonly referent: Referent;
  readonly value: Value;
  readonly mode: Mode;
  readonly eventTime: EventTime;
  readonly observationTime: ObservationTime;
  readonly provenance: Provenance;
  readonly completeness: Completeness;
  readonly coverage: Coverage;
  readonly confidenceBasis: ConfidenceBasis;
  readonly causeRef?: CauseRef;
  readonly processInstanceRef?: ProcessInstanceRef;

  // Pinned run identity.
  readonly context: ExecutionContext;
}

/**
 * The content-bearing shape used to build an observation, BEFORE identity is
 * sealed. canonicalHash covers exactly this object (all content + context), so
 * any change to any field yields a new Account.
 */
export type ObservationContent = Omit<
  CanonicalObservation,
  "sourceObservationId" | "observationAccountId" | "canonicalHash"
>;
