/**
 * Father Engine — C0 / PR3. Normalization result contract.
 *
 * normalize() returns EITHER a sealed CanonicalObservation OR a typed rejection —
 * it never fabricates a COT to represent "Unknown". A rejection carries a typed,
 * canonical IDENTITY (not a free-form string) that fully fingerprints WHY it was
 * rejected, so downstream Replay can reproduce the complete run behaviour — the
 * successes AND the exact rejections — not just the failure category.
 */

import type { CanonicalObservation, Mode, ObservationTime, RealityTier, Scale } from "../observation.types";
import type {
  ConceptId,
  ConceptVersion,
  RealityTierVocabularyId,
  RegistrySnapshotDigest,
} from "../versioning.types";
import type { CoverageKey } from "../registry/coverage-registry";

export interface RawRecordRef {
  featureDomain: string;
  sourceModel: string;
  sourceRecordId: string;
}

export interface SourceRef {
  ref: RawRecordRef;
  emittedObservationIndex?: number;
}

export type NormalizationFailureReason =
  | "SNAPSHOT_MISMATCH"
  | "UNKNOWN_CONCEPT"
  | "UNKNOWN_CONCEPT_VERSION"
  | "NO_EFFECTIVE_CONCEPT_VERSION"
  | "REQUESTED_CONCEPT_VERSION_NOT_EFFECTIVE"
  | "CONCEPT_VERSION_AMBIGUOUS"
  | "VALUE_SHAPE_MISMATCH"
  | "MISSING_REQUIRED_FIELD"
  | "COVERAGE_ENTRY_MISSING"
  | "INVALID_REALITY_TIER"
  | "CHANNEL_LAUNDERING";

/** Stable machine path to the offending field, or "$record" for a record-level fault. */
export type FieldPath = string;

/**
 * Typed, canonical identity of a rejection — one variant per failure reason, each
 * carrying only STABLE fields (no message, no stack, no object identity, no raw
 * `details`). Two distinct rejections must never share an identity.
 */
export type NormalizationRejectionIdentity =
  | { reason: "SNAPSHOT_MISMATCH"; expectedSnapshot: RegistrySnapshotDigest; actualSnapshot: RegistrySnapshotDigest }
  | { reason: "UNKNOWN_CONCEPT"; conceptId: ConceptId }
  | { reason: "UNKNOWN_CONCEPT_VERSION"; conceptId: ConceptId; requestedVersion: ConceptVersion }
  | { reason: "NO_EFFECTIVE_CONCEPT_VERSION"; conceptId: ConceptId; observationTime: ObservationTime }
  | {
      reason: "REQUESTED_CONCEPT_VERSION_NOT_EFFECTIVE";
      conceptId: ConceptId;
      requestedVersion: ConceptVersion;
      observationTime: ObservationTime;
    }
  | {
      reason: "CONCEPT_VERSION_AMBIGUOUS";
      conceptId: ConceptId;
      observationTime: ObservationTime;
      /** Canonical: sorted, de-duplicated. Never insertion order. */
      candidateVersions: readonly ConceptVersion[];
    }
  | {
      reason: "VALUE_SHAPE_MISMATCH";
      expectedMode: Mode;
      expectedScale: Scale;
      expectedUnitDimension: string | null;
      actualMode: Mode;
      actualScale: Scale;
      actualUnit: string | null;
    }
  | { reason: "MISSING_REQUIRED_FIELD"; field: FieldPath }
  | { reason: "COVERAGE_ENTRY_MISSING"; coverageKey: CoverageKey }
  | {
      reason: "INVALID_REALITY_TIER";
      rejectedToken: RealityTier;
      vocabularyId: RealityTierVocabularyId;
      location: { kind: "RECORD" } | { kind: "FIELD"; fieldPath: FieldPath };
    }
  | {
      reason: "CHANNEL_LAUNDERING";
      violation: "INFERENCE_WITHOUT_SUBSTRATE" | "BLANK_FIELD_PROVENANCE";
      fieldPath: FieldPath;
    };

export type NormalizationResult =
  | { ok: true; observation: CanonicalObservation }
  | { ok: false; source: SourceRef; identity: NormalizationRejectionIdentity };

// --- compile-time exhaustiveness (bidirectional) ---------------------------
// Every failure reason must have exactly one identity variant, and no identity
// variant may name a reason that is not a failure reason.
type AssertNever<T extends never> = T;
type _EveryReasonHasIdentity = AssertNever<
  Exclude<NormalizationFailureReason, NormalizationRejectionIdentity["reason"]>
>;
type _NoStaleIdentity = AssertNever<
  Exclude<NormalizationRejectionIdentity["reason"], NormalizationFailureReason>
>;
// Reference the guards so they are evaluated (and never reported as unused).
export type NormalizationRejectionExhaustive = _EveryReasonHasIdentity & _NoStaleIdentity;
