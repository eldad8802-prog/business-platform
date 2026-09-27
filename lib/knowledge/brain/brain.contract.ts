/**
 * M8 · The Central Dubiz Brain — contract.
 *
 *   bks.v1 snapshot ──► context builder ──► model ──► BrainReasoningResult (raw)
 *                                                        │
 *                                  deterministic validator (schema + grounding)
 *                                                        ▼
 *                                         ValidatedBrainResult ──► deterministic renderer
 *
 * The model CONNECTS, INTERPRETS, PRIORITISES and FORMULATES. It never establishes a fact: every
 * observation must cite knowledge the deterministic system already holds, and anything it cannot
 * cite is rejected — not repaired.
 *
 * WHAT THE MODEL MAY RETURN (v1)
 *   observation     what the cited knowledge directly says — required, grounded
 *   interpretation  why it may deserve attention — optional, grounded in the same refs
 *   hypothesis      NOT ENABLED in v1: any non-null hypothesis rejects the finding. A possible
 *                   explanation is exactly the thing an owner would read as a fact, and the product
 *                   has no surface yet that could render it as clearly hypothetical.
 *   causalClaim     must be false: bks.v1 carries no causal authority, so no causal claim can be
 *                   grounded. The field exists so a violation is explicit and machine-detectable.
 *
 * WHAT IT NEVER CONTAINS: chain-of-thought (not requested, not stored), recommendations or actions
 * (M9), confidence percentages (uncertainty is a category with a reason).
 */

export const BRAIN_CONTRACT_VERSION = "brain.v1";

/** Small on purpose. An insight explains what matters; it is not a recommendation. */
export const FINDING_TYPES = ["ATTENTION", "CHANGE", "CROSS_DOMAIN_CONTEXT", "KNOWLEDGE_LIMITATION"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Uncertainty as a REASON, never a number.
 *   SUPPORTED         every statement rests on cited ACTIVE knowledge
 *   LIMITED_BY_GAP    supported, but a cited gap limits what can be said
 *   CONFLICT_PRESENT  a cited item is in an unresolved conflict; neither side is treated as settled
 */
export const UNCERTAINTY = ["SUPPORTED", "LIMITED_BY_GAP", "CONFLICT_PRESENT"] as const;
export type Uncertainty = (typeof UNCERTAINTY)[number];

/** One finding exactly as the model must return it. Refs are the context's short aliases (K1, F2, …). */
export type RawBrainFinding = {
  findingId: string;
  type: FindingType;
  priority: Priority;
  knowledgeRefs: string[];
  findingRefs: string[];
  conflictRefs: string[];
  gapRefs: string[];
  observation: string;
  interpretation: string | null;
  hypothesis: string | null;
  causalClaim: boolean;
  uncertainty: Uncertainty;
};

export type RawBrainResult = {
  contextFingerprint: string;
  outcome: "FINDINGS" | "NO_ACTIONABLE_INSIGHT" | "NOT_ENOUGH_KNOWLEDGE";
  findings: RawBrainFinding[];
};

/** The provider-side JSON schema (OpenAI strict structured output). Mirrors RawBrainResult exactly. */
export const RAW_RESULT_JSON_SCHEMA = {
  name: "dubiz_brain_result_v1",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["contextFingerprint", "outcome", "findings"],
    properties: {
      contextFingerprint: { type: "string" },
      outcome: { type: "string", enum: ["FINDINGS", "NO_ACTIONABLE_INSIGHT", "NOT_ENOUGH_KNOWLEDGE"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["findingId", "type", "priority", "knowledgeRefs", "findingRefs", "conflictRefs", "gapRefs",
            "observation", "interpretation", "hypothesis", "causalClaim", "uncertainty"],
          properties: {
            findingId: { type: "string" },
            type: { type: "string", enum: [...FINDING_TYPES] },
            priority: { type: "string", enum: [...PRIORITIES] },
            knowledgeRefs: { type: "array", items: { type: "string" } },
            findingRefs: { type: "array", items: { type: "string" } },
            conflictRefs: { type: "array", items: { type: "string" } },
            gapRefs: { type: "array", items: { type: "string" } },
            observation: { type: "string" },
            interpretation: { type: ["string", "null"] },
            hypothesis: { type: ["string", "null"] },
            causalClaim: { type: "boolean" },
            uncertainty: { type: "string", enum: [...UNCERTAINTY] },
          },
        },
      },
    },
  },
} as const;

/** Why a finding (or the whole result) was rejected. Codes only — never the offending text. */
export type RejectionCode =
  | "SCHEMA_INVALID"
  | "CONTEXT_FINGERPRINT_MISMATCH"
  | "UNKNOWN_REF"
  | "NO_POSITIVE_GROUNDING"
  | "GAP_USED_AS_FACT"
  | "CAUSAL_CLAIM"
  | "CAUSAL_WORDING"
  | "HYPOTHESIS_NOT_ENABLED"
  | "UNGROUNDED_NUMBER"
  | "CONFLICT_NOT_ACKNOWLEDGED"
  | "LIMITATION_WITHOUT_GAP"
  | "TEXT_TOO_LONG"
  | "FORBIDDEN_CONTENT"
  | "DUPLICATE_FINDING_ID"
  | "TOO_MANY_FINDINGS";

/** A finding that survived every check, re-expressed in snapshot terms (slots, not aliases). */
export type ValidatedFinding = {
  /** Stable across re-runs over the same knowledge: sha256 of type + sorted cited slots. */
  readonly findingKey: string;
  readonly type: FindingType;
  readonly priority: Priority;
  readonly uncertainty: Uncertainty;
  readonly observation: string;
  readonly interpretation: string | null;
  /** Snapshot slots of the cited knowledge / findings / conflicts / gaps — the provenance path. */
  readonly knowledgeSlots: readonly string[];
  readonly findingSlots: readonly string[];
  readonly conflictIds: readonly string[];
  readonly gapSlots: readonly string[];
  readonly subjects: readonly { type: string; id: number | string }[];
};

export type BrainStatus =
  | "FINDINGS"
  | "NO_ACTIONABLE_INSIGHT"
  | "NOT_ENOUGH_KNOWLEDGE"
  | "DISABLED"
  | "PROVIDER_FAILED"
  | "INVALID_OUTPUT";

export type BrainRunMeta = {
  readonly contractVersion: typeof BRAIN_CONTRACT_VERSION;
  readonly promptVersion: string;
  readonly contextVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly snapshotFingerprint: string;
  readonly contextFingerprint: string;
  readonly contextBytes: number;
  readonly contextOmitted: Record<string, number>;
  readonly modelCalled: boolean;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly failureStage: "disabled" | "snapshot" | "provider" | "schema" | "grounding" | null;
};

export type ValidatedBrainResult = {
  readonly businessId: number;
  readonly status: BrainStatus;
  readonly findings: readonly ValidatedFinding[];
  readonly rejected: readonly { readonly findingId: string | null; readonly code: RejectionCode }[];
  readonly meta: BrainRunMeta;
};
