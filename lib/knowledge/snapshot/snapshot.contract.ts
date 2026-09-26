/**
 * M7 · The Business Knowledge Snapshot contract — what Dubiz currently KNOWS about ONE business.
 *
 * THE AI BOUNDARY
 *
 *      PRODUCT DATABASE
 *            ↓
 *      DETERMINISTIC LEARNING SYSTEM   (facts, claims, measures, temporal knowledge, identity)
 *            ↓
 *      BUSINESS KNOWLEDGE SNAPSHOT     (this contract)
 *   ─────────────────────────────────────────────  AI boundary (M8, not built)
 *
 * A future reasoning layer consumes THIS, never the database. If it needs something that is not
 * here, the answer is a new governed knowledge producer — not SQL, and not a wider snapshot.
 *
 * WHAT IT IS NOT
 *   - a database dump: every item is knowledge with a type, an authority and a provenance
 *   - multi-tenant: one businessId, read inside that business's tenant transaction
 *   - an explanation: findings state what co-occurs; none of them states a cause
 *   - a recommendation: nothing here says what the owner should do
 *   - a carrier of raw content: no names, phones, emails, message or document text, notes, tokens,
 *     provider payloads or error strings. Subjects are typed ids.
 */

export const SNAPSHOT_CONTRACT_VERSION = "bks.v1";

/** The taxonomy, kept apart on purpose — a measure is not a baseline, a baseline is not a finding. */
export type KnowledgeKind =
  | "FACT"
  | "CLAIM"
  | "MEASURE"
  | "BASELINE"
  | "STABLE_PATTERN"
  | "TREND"
  | "MATERIAL_CHANGE"
  | "ANOMALY"
  | "OWNER_DECISION";

/**
 * WHO vouches for an item. A reasoning layer must be able to tell "the ledger says" from "Dubiz
 * inferred", and these are ordered by that difference, strongest first.
 *
 *   AUTHORITATIVE_DOMAIN_STATE  read from the product's own ledgers (installments + allocations,
 *                               issued invoices + receipts, owner-initiated reminders)
 *   OWNER_CONFIRMED             a person of this business decided it (identity confirmation,
 *                               insight decision)
 *   AUTHORITATIVE_IDENTIFIER    bound by a state-issued identifier (a valid tax id)
 *   KNOWLEDGE_MEASURE           a governed M2/M4 rule over evidence
 *   TEMPORAL_DERIVATION         a governed M6 rule over this business's own history
 *   DERIVED_CLAIM               Business Memory's categorical inference (may be contested)
 *   CROSS_DOMAIN_DERIVATION     an M7 rule combining the above — never stronger than its premises
 *   MACHINE_PROPOSAL            a suggestion awaiting a person; never usable as a premise
 */
export type AuthorityClass =
  | "AUTHORITATIVE_DOMAIN_STATE"
  | "OWNER_CONFIRMED"
  | "AUTHORITATIVE_IDENTIFIER"
  | "KNOWLEDGE_MEASURE"
  | "TEMPORAL_DERIVATION"
  | "DERIVED_CLAIM"
  | "CROSS_DOMAIN_DERIVATION"
  | "MACHINE_PROPOSAL";

/** Where an item lives, so a consumer can walk back from it to its evidence. Row ids, not payloads. */
export type ProvenanceRef = {
  readonly store:
    | "KnowledgeMeasure"
    | "TemporalKnowledge"
    | "DerivedClaimProjection"
    | "BusinessInsight"
    | "PartyResolutionClaim"
    | "EntityLinkProposal"
    | "BusinessStatus"
    | "AwaitingPayment"
    | "PayablesExposure"
    | "CollectionAction";
  readonly id: number | string;
};

export type Subject = { readonly type: string; readonly id: number | string } | null;

export type Freshness = {
  /** Days between the item's own window end (or decision/observation time) and the snapshot's asOf. */
  readonly ageDays: number;
  /** Fresh enough to serve as a premise for a cross-domain rule. */
  readonly fresh: boolean;
};

export type KnowledgeItem = {
  /** Deterministic identity of the SEMANTIC slot — the unit of deduplication and conflict. */
  readonly slot: string;
  readonly kind: KnowledgeKind;
  readonly domain: string;
  readonly subject: Subject;
  readonly key: string;
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  readonly authority: AuthorityClass;
  /** Structured value. Never free text. */
  readonly value: Record<string, unknown>;
  readonly observationCount: number | null;
  readonly window: { readonly start: string; readonly end: string } | null;
  readonly status: "ACTIVE";
  readonly freshness: Freshness;
  readonly evidence: { readonly fingerprint: string | null; readonly refCount: number | null };
  /** Known product defects that affect this item's truth, stated with the item rather than hidden. */
  readonly caveats: readonly string[];
  /** Every stored row that expressed this same knowledge (more than one only after deduplication). */
  readonly provenance: readonly ProvenanceRef[];
  readonly conflictIds: readonly string[];
};

export type RelationshipItem = {
  readonly slot: string;
  readonly type: "SAME_COUNTERPARTY";
  readonly left: NonNullable<Subject>;
  readonly right: NonNullable<Subject>;
  /** The shared identity anchor. */
  readonly via: { readonly type: "party"; readonly id: number };
  /** ACTIVE = usable; PROPOSED = a machine suggestion, NOT usable; REJECTED = the owner said no. */
  readonly status: "ACTIVE" | "PROPOSED" | "REJECTED";
  readonly authority: AuthorityClass;
  readonly provenance: readonly ProvenanceRef[];
};

/** What a cross-domain finding may assert. None of these is a cause, a driver or an impact. */
export type FindingType =
  | "EXPOSURE_WITH_RECORDED_ACTIVITY"
  | "LINKED_COUNTERPARTY_CONDITION";

export type CrossDomainFinding = {
  readonly slot: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly type: FindingType;
  readonly domains: readonly string[];
  readonly subject: NonNullable<Subject>;
  /** The one sentence of what this establishes — and nothing more. */
  readonly establishes: string;
  readonly causal: false;
  readonly authority: "CROSS_DOMAIN_DERIVATION";
  readonly value: Record<string, unknown>;
  /** The premises, by slot and store reference. Walk these back to evidence. */
  readonly premises: readonly { readonly slot: string; readonly authority: AuthorityClass; readonly provenance: readonly ProvenanceRef[] }[];
  readonly caveats: readonly string[];
};

export type ConflictItem = {
  readonly conflictId: string;
  readonly kind: "COMPETING_CLAIM_VALUES" | "MACHINE_VS_OWNER" | "PROPOSAL_VS_AUTHORITATIVE_IDENTITY" | "DIVERGENT_SAME_SLOT";
  readonly slot: string;
  /** RESOLVED_BY_AUTHORITY only where authority genuinely exists; otherwise UNRESOLVED, both sides kept. */
  readonly resolution: "UNRESOLVED" | "RESOLVED_BY_AUTHORITY";
  readonly prevailing: AuthorityClass | null;
  readonly sides: readonly { readonly authority: AuthorityClass; readonly value: Record<string, unknown>; readonly provenance: readonly ProvenanceRef[] }[];
};

export type KnowledgeGap = {
  readonly slot: string;
  readonly domain: string;
  readonly key: string;
  readonly ruleId: string | null;
  readonly kind: "INSUFFICIENT_HISTORY" | "INSUFFICIENT_EVIDENCE" | "PREMISE_UNAVAILABLE" | "RULE_BLOCKED";
  readonly reason: string;
  /** Normalised: one gap per (rule, reason), however many subjects share it. */
  readonly subjectsAffected: number;
  readonly have: { readonly min: number; readonly max: number } | null;
  readonly need: number | null;
  readonly needSpanDays: number | null;
};

export type SnapshotStats = {
  readonly counts: Record<string, number>;
  readonly truncated: Record<string, number>;
  readonly serializedBytes: number;
  readonly largestSection: string;
  readonly queries: number;
};

export type BusinessKnowledgeSnapshot = {
  readonly contractVersion: typeof SNAPSHOT_CONTRACT_VERSION;
  readonly businessId: number;
  readonly asOf: string;
  readonly knowledge: readonly KnowledgeItem[];
  readonly relationships: readonly RelationshipItem[];
  readonly crossDomainFindings: readonly CrossDomainFinding[];
  readonly conflicts: readonly ConflictItem[];
  readonly knowledgeGaps: readonly KnowledgeGap[];
  /**
   * sha256 over the SEMANTIC content only: no row ids, no materialization or confirmation timestamps,
   * no stats. Same business + same knowledge + same asOf → same fingerprint.
   */
  readonly snapshotFingerprint: string;
  readonly stats: SnapshotStats;
};

/** Explicit bounds. Everything is ordered deterministically before a bound applies; cuts are counted. */
export const SNAPSHOT_BOUNDS = {
  knowledge: 400,
  relationships: 200,
  crossDomainFindings: 100,
  conflicts: 100,
  knowledgeGaps: 100,
} as const;

/** A premise older than this is not fresh enough to support a cross-domain finding. */
export const PREMISE_MAX_AGE_DAYS = 45;
