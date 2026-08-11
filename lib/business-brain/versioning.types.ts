/**
 * Father Engine — C0. Shared versioning & identity types.
 *
 * The SINGLE home for the branded scalar identities used across BOTH the COT
 * (observation.types.ts) and the Registries (registry/*). There is exactly one
 * type per semantic identity — no parallel mirrors (no RegistryTranslatorName vs
 * ObservationTranslatorName). Continuing the PR1 line: identities are branded so
 * they cannot be mixed or swapped by accident.
 *
 * Constructors are the ONLY place that mints a branded value. They are NOT free
 * casts — each performs minimal structural validation and throws a BrainError on
 * an invalid value (empty / whitespace-only / surrounding whitespace). They are
 * byte-preserving: a clean input is returned unchanged, so re-typing a PR1 field
 * from `string` to a brand changes zero bytes in any hash.
 *
 * RegistrySnapshotDigest is deliberately NOT constructible here — it may only be
 * produced by buildSnapshot() or validated by parseSnapshotDigest() (see
 * registry/registry-snapshot.ts), so an invented digest can never be attached to
 * an ExecutionContext.
 */

import { BrainError } from "./brain-error";

// ── Branded scalar identities ────────────────────────────────────────────────

export type ConceptId = string & { readonly __brand: "ConceptId" };
export type ConceptVersion = string & { readonly __brand: "ConceptVersion" };
export type TranslatorName = string & { readonly __brand: "TranslatorName" };
export type TranslatorVersionTag = string & { readonly __brand: "TranslatorVersionTag" };
export type EngineEpochId = string & { readonly __brand: "EngineEpochId" };
export type CotSchemaVersion = string & { readonly __brand: "CotSchemaVersion" };
export type ExecutionPolicyVersion = string & { readonly __brand: "ExecutionPolicyVersion" };
export type ReferentSubtype = string & { readonly __brand: "ReferentSubtype" };

/** Content fingerprint of a registry snapshot. Type lives here (COT needs it);
 *  values are minted only by registry/registry-snapshot.ts. */
export type RegistrySnapshotDigest = string & { readonly __brand: "RegistrySnapshotDigest" };

/** Version of the canonical snapshot SHAPE itself — participates in every digest
 *  so a future change to snapshot form cannot masquerade as the same digest. */
export type RegistrySnapshotSchemaVersion = string & {
  readonly __brand: "RegistrySnapshotSchemaVersion";
};

/** Human name of a RealityTier vocabulary (e.g. "fixture-tiers@1"). */
export type RealityTierVocabularyId = string & {
  readonly __brand: "RealityTierVocabularyId";
};

/** Content-derived fingerprint of a RealityTier vocabulary — same id + different
 *  content ⇒ different digest ⇒ pinning failure. Minted only from the canonical
 *  vocabulary content (see normalization/reality-tier-registry.ts). */
export type RealityTierVocabularyDigest = string & {
  readonly __brand: "RealityTierVocabularyDigest";
};

/** Version pinning the normalize() decision RULESET (version selection, value-shape,
 *  required-field, provenance, coverage resolution, failure-reason taxonomy). Bump on
 *  any change to those rules. Separate from ExecutionPolicyVersion (which is broader
 *  and forward-looking, e.g. ConfidencePolicy later). */
export type NormalizationPolicyVersion = string & {
  readonly __brand: "NormalizationPolicyVersion";
};

/** Content-derived fingerprint of a translator's DECLARED contract. Same name+version
 *  with a different contract ⇒ different digest ⇒ pinning failure. Minted only from the
 *  declared contract content. */
export type TranslatorContractDigest = string & {
  readonly __brand: "TranslatorContractDigest";
};

// ── Validation ───────────────────────────────────────────────────────────────

/** Reject empty, whitespace-only, or surrounding-whitespace values. Returns the
 *  value UNCHANGED (byte-preserving) so hashes are unaffected by re-typing. */
function requireClean(kind: string, value: string): string {
  if (typeof value !== "string") {
    throw new BrainError("INVALID_VERSIONING_ID", `${kind} must be a string`, { value });
  }
  if (value.length === 0) {
    throw new BrainError("INVALID_VERSIONING_ID", `${kind} cannot be empty`);
  }
  if (value.trim().length === 0) {
    throw new BrainError("INVALID_VERSIONING_ID", `${kind} cannot be whitespace only`, { value });
  }
  if (value !== value.trim()) {
    throw new BrainError(
      "INVALID_VERSIONING_ID",
      `${kind} must not have surrounding whitespace`,
      { value }
    );
  }
  return value;
}

// ── Constructors (developer / fixture minted identities) ─────────────────────

export const conceptId = (v: string): ConceptId => requireClean("ConceptId", v) as ConceptId;
export const conceptVersion = (v: string): ConceptVersion =>
  requireClean("ConceptVersion", v) as ConceptVersion;
export const translatorName = (v: string): TranslatorName =>
  requireClean("TranslatorName", v) as TranslatorName;
export const translatorVersionTag = (v: string): TranslatorVersionTag =>
  requireClean("TranslatorVersionTag", v) as TranslatorVersionTag;
export const engineEpochId = (v: string): EngineEpochId =>
  requireClean("EngineEpochId", v) as EngineEpochId;
export const cotSchemaVersion = (v: string): CotSchemaVersion =>
  requireClean("CotSchemaVersion", v) as CotSchemaVersion;
export const executionPolicyVersion = (v: string): ExecutionPolicyVersion =>
  requireClean("ExecutionPolicyVersion", v) as ExecutionPolicyVersion;
export const referentSubtype = (v: string): ReferentSubtype =>
  requireClean("ReferentSubtype", v) as ReferentSubtype;
export const realityTierVocabularyId = (v: string): RealityTierVocabularyId =>
  requireClean("RealityTierVocabularyId", v) as RealityTierVocabularyId;
export const normalizationPolicyVersion = (v: string): NormalizationPolicyVersion =>
  requireClean("NormalizationPolicyVersion", v) as NormalizationPolicyVersion;
export const registrySnapshotSchemaVersion = (v: string): RegistrySnapshotSchemaVersion =>
  requireClean("RegistrySnapshotSchemaVersion", v) as RegistrySnapshotSchemaVersion;

/** The snapshot shape version pinned by PR2. Bump on any change to the canonical
 *  snapshot form (kind/schemaVersion/entries envelope in buildSnapshot). */
export const REGISTRY_SNAPSHOT_SCHEMA_VERSION: RegistrySnapshotSchemaVersion =
  registrySnapshotSchemaVersion("regsnap-schema@1");
