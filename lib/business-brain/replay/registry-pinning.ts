/**
 * Father Engine — C0 / PR4. Full dependency pinning.
 *
 * Verifies that EVERY dependency whose change could alter a normalize run matches
 * the pinned ReplayDependencyContext, before any manifest is built. Any mismatch
 * is a typed failure — never a fallback.
 */

import type { NormalizeDeps } from "../normalization/normalize";
import { NORMALIZATION_POLICY_VERSION } from "../normalization/normalize";
import type { TranslatorRegistry } from "../registry/translator-registry";
import type { EngineEpochRegistry } from "../registry/engine-epoch-registry";
import type {
  PinningResult,
  ReplayDependencyContext,
  ReplayPinningFailureReason,
} from "./replay.types";

export interface ReplayDeps extends NormalizeDeps {
  translatorRegistry: TranslatorRegistry;
  engineEpochRegistry: EngineEpochRegistry;
  dependencyContext: ReplayDependencyContext;
}

function fail(reason: ReplayPinningFailureReason, detail: string): PinningResult {
  return { ok: false, reason, detail };
}

export function verifyPinning(deps: ReplayDeps): PinningResult {
  const dc = deps.dependencyContext;
  const ctx = deps.context;

  // Concept registry snapshot — actual vs pinned vs context.
  if (deps.conceptRegistry.snapshot.digest !== dc.conceptRegistrySnapshot) {
    return fail("CONCEPT_SNAPSHOT_MISMATCH", "conceptRegistry vs dependencyContext");
  }
  if (ctx.conceptRegistrySnapshot !== dc.conceptRegistrySnapshot) {
    return fail("CONCEPT_SNAPSHOT_MISMATCH", "executionContext vs dependencyContext");
  }

  // Coverage / translator / engine-epoch registry snapshots.
  if (deps.coverageRegistry.snapshot.digest !== dc.coverageRegistrySnapshot) {
    return fail("COVERAGE_SNAPSHOT_MISMATCH", "coverageRegistry vs dependencyContext");
  }
  if (deps.translatorRegistry.snapshot.digest !== dc.translatorRegistrySnapshot) {
    return fail("TRANSLATOR_SNAPSHOT_MISMATCH", "translatorRegistry vs dependencyContext");
  }
  if (deps.engineEpochRegistry.snapshot.digest !== dc.engineEpochRegistrySnapshot) {
    return fail("ENGINE_EPOCH_SNAPSHOT_MISMATCH", "engineEpochRegistry vs dependencyContext");
  }

  // RealityTier vocabulary — id AND content digest.
  if (deps.realityTierValidator.vocabularyId !== dc.realityTierVocabularyId) {
    return fail("REALITY_TIER_VOCABULARY_MISMATCH", "vocabularyId");
  }
  if (deps.realityTierValidator.vocabularyDigest !== dc.realityTierVocabularyDigest) {
    return fail("REALITY_TIER_VOCABULARY_MISMATCH", "vocabularyDigest (same id, different content)");
  }

  // Normalize ruleset version.
  if (dc.normalizationPolicyVersion !== NORMALIZATION_POLICY_VERSION) {
    return fail("NORMALIZATION_POLICY_MISMATCH", "dependencyContext vs code");
  }

  // Translator: registered + version + contract digest (actual vs registered vs pinned).
  const tv = ctx.translatorVersion;
  const resolved = deps.translatorRegistry.resolve(tv.translatorName, tv.version);
  if (resolved.status === "UNKNOWN_TRANSLATOR") {
    return fail("TRANSLATOR_NOT_REGISTERED", `${tv.translatorName}`);
  }
  if (resolved.status === "UNKNOWN_VERSION") {
    return fail("TRANSLATOR_VERSION_MISMATCH", `${tv.translatorName}@${tv.version} not registered`);
  }
  if (deps.translator.name !== tv.translatorName || deps.translator.version !== tv.version) {
    return fail("TRANSLATOR_VERSION_MISMATCH", "live translator vs executionContext");
  }
  if (deps.translator.contractDigest !== resolved.definition.translatorContractDigest) {
    return fail("TRANSLATOR_CONTRACT_MISMATCH", "live translator vs registered contract");
  }
  if (resolved.definition.translatorContractDigest !== dc.translatorContractDigest) {
    return fail("TRANSLATOR_CONTRACT_MISMATCH", "registered contract vs dependencyContext");
  }

  // Engine epoch: exists + links to the same concept snapshot + policy version.
  const epoch = deps.engineEpochRegistry.resolve(ctx.engineEpoch.epochId);
  if (epoch.status === "UNKNOWN_EPOCH") {
    return fail("ENGINE_EPOCH_MISSING", `${ctx.engineEpoch.epochId}`);
  }
  if (epoch.definition.conceptRegistrySnapshot !== ctx.conceptRegistrySnapshot) {
    return fail("ENGINE_EPOCH_CONCEPT_SNAPSHOT_MISMATCH", "epoch vs executionContext");
  }
  if (epoch.definition.executionPolicyVersion !== ctx.executionPolicyVersion) {
    return fail("EXECUTION_POLICY_MISMATCH", "epoch vs executionContext");
  }

  return { ok: true };
}
