/**
 * Father Engine — C0 / PR4. Replay Harness types.
 *
 * A Replay Manifest is the FULL identity of a normalize run under a pinned
 * dependency set — successes AND typed rejections AND the pinned dependencies —
 * not just the successful accounts and not just failure categories. No inference
 * invocation, no silent fallback, no supersession, no overwrite.
 */

import type {
  CanonicalHash,
  CanonicalObservation,
  ExecutionContext,
  ObservationAccountId,
  SourceObservationId,
} from "../observation.types";
import type {
  NormalizationPolicyVersion,
  RealityTierVocabularyDigest,
  RealityTierVocabularyId,
  RegistrySnapshotDigest,
  TranslatorContractDigest,
} from "../versioning.types";
import type {
  NormalizationRejectionIdentity,
  SourceRef,
} from "../normalization/normalization-result.types";

export type ExecutionMode = "HISTORICAL_REPLAY" | "REPROCESS_NEW_EPOCH" | "LIVE_NORMALIZE";

export type ReplayManifestDigest = string & { readonly __brand: "ReplayManifestDigest" };
export type ReplayManifestSchemaVersion = string & {
  readonly __brand: "ReplayManifestSchemaVersion";
};
export type RejectionIdentityDigest = string & { readonly __brand: "RejectionIdentityDigest" };
export type AccountsDigest = string & { readonly __brand: "AccountsDigest" };

/**
 * The complete set of dependencies whose change could alter a normalize run —
 * the superset needed to reproduce it. Deliberately duplicates
 * executionContext.conceptRegistrySnapshot; verifyPinning asserts the overlapping
 * values are consistent. Lives in the REPLAY layer only — never on the COT.
 */
export interface ReplayDependencyContext {
  executionContext: ExecutionContext;
  conceptRegistrySnapshot: RegistrySnapshotDigest;
  coverageRegistrySnapshot: RegistrySnapshotDigest;
  translatorRegistrySnapshot: RegistrySnapshotDigest;
  engineEpochRegistrySnapshot: RegistrySnapshotDigest;
  realityTierVocabularyId: RealityTierVocabularyId;
  realityTierVocabularyDigest: RealityTierVocabularyDigest;
  translatorContractDigest: TranslatorContractDigest;
  normalizationPolicyVersion: NormalizationPolicyVersion;
}

export interface ReplayManifestEntry {
  sourceObservationId: SourceObservationId;
  observationAccountId: ObservationAccountId;
  canonicalHash: CanonicalHash;
}

export interface ReplayRejectionEntry {
  sourceRef: SourceRef;
  identity: NormalizationRejectionIdentity;
  identityDigest: RejectionIdentityDigest;
}

/** The raw material a manifest is built from — successes + typed rejections. Both
 *  the live path and the stored-outcome audit go through this single shape. */
export interface ReplayOutcomeSet {
  accounts: readonly CanonicalObservation[];
  rejections: readonly ReplayRejectionEntry[];
}

export interface ReplayManifest {
  manifestSchemaVersion: ReplayManifestSchemaVersion;
  executionMode: ExecutionMode;
  dependencyContext: ReplayDependencyContext;
  accountCount: number;
  accounts: readonly ReplayManifestEntry[]; // ordered by observationAccountId
  rejectionCount: number;
  rejections: readonly ReplayRejectionEntry[]; // canonically ordered
  manifestDigest: ReplayManifestDigest;
}

/** A NARROWER manifest — accounts only. It never represents rejections and is NOT
 *  equivalent to a ReplayManifest. */
export interface AccountAuditManifest {
  manifestSchemaVersion: ReplayManifestSchemaVersion;
  accountCount: number;
  accounts: readonly ReplayManifestEntry[];
  accountsDigest: AccountsDigest;
}

export type ReplayPinningFailureReason =
  | "CONCEPT_SNAPSHOT_MISMATCH"
  | "COVERAGE_SNAPSHOT_MISMATCH"
  | "TRANSLATOR_SNAPSHOT_MISMATCH"
  | "ENGINE_EPOCH_SNAPSHOT_MISMATCH"
  | "ENGINE_EPOCH_MISSING"
  | "ENGINE_EPOCH_CONCEPT_SNAPSHOT_MISMATCH"
  | "EXECUTION_POLICY_MISMATCH"
  | "NORMALIZATION_POLICY_MISMATCH"
  | "TRANSLATOR_NOT_REGISTERED"
  | "TRANSLATOR_VERSION_MISMATCH"
  | "TRANSLATOR_CONTRACT_MISMATCH"
  | "REALITY_TIER_VOCABULARY_MISMATCH";

export type PinningResult =
  | { ok: true }
  | { ok: false; reason: ReplayPinningFailureReason; detail: string };

export interface ReplayDivergence {
  missingAccounts: readonly ObservationAccountId[];
  unexpectedAccounts: readonly ObservationAccountId[];
  changedBySource: readonly {
    sourceObservationId: SourceObservationId;
    expected?: ObservationAccountId;
    actual?: ObservationAccountId;
  }[];
  missingRejections: readonly ReplayRejectionEntry[];
  unexpectedRejections: readonly ReplayRejectionEntry[];
}

export type ReplayComparisonResult =
  | { ok: true }
  | { ok: false; reason: "REPLAY_MANIFEST_DIVERGENCE"; divergence: ReplayDivergence };

export interface ReplayRun {
  mode: ExecutionMode;
  pinning: PinningResult;
  outcomes: ReplayOutcomeSet;
  /** Present iff pinning succeeded — a manifest is never built under failed pinning. */
  manifest?: ReplayManifest;
}

export const REPLAY_MANIFEST_SCHEMA_VERSION = "replaymanifest-schema@1" as ReplayManifestSchemaVersion;
