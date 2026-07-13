/**
 * Father Engine — C0 / PR3. Normalization result contract.
 *
 * normalize() returns EITHER a sealed CanonicalObservation OR a typed rejection —
 * it never fabricates a COT to represent "Unknown". Unknown is a rejection here,
 * or a downstream Coverage-Gate outcome, never invented Evidence.
 */

import type { CanonicalObservation } from "../observation.types";

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

export type NormalizationResult =
  | { ok: true; observation: CanonicalObservation }
  | {
      ok: false;
      reason: NormalizationFailureReason;
      source: SourceRef;
      details?: string;
    };
