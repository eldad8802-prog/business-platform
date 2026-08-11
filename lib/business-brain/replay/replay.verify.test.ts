/**
 * C0 / PR4 — Replay Harness verification.
 * Run with:  npx tsx lib/business-brain/replay/replay.verify.test.ts
 * (or: npm run verify:brain-replay)
 *
 * Pure logic only — no DB, no SoT, no inference invocation, no replay of OCR/LLM.
 * Proves full dependency pinning, manifest identity (accounts + typed rejections),
 * historical replay comparison, reprocess siblings, and deterministic timeline.
 */
import assert from "node:assert/strict";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
  normalizationPolicyVersion,
  realityTierVocabularyId,
  translatorName,
  translatorVersionTag,
} from "../versioning.types";
import type { ExecutionContext } from "../observation.types";
import {
  buildConceptRegistry,
  type BusinessConceptDefinition,
  type ConceptValueShape,
} from "../registry/concept-registry";
import { buildCoverageRegistry, type CoverageEntry } from "../registry/coverage-registry";
import { buildTranslatorRegistry } from "../registry/translator-registry";
import { buildEngineEpochRegistry } from "../registry/engine-epoch-registry";
import {
  buildRealityTierValidator,
  fixtureRealityTierValidator,
} from "../normalization/reality-tier-registry";
import { NORMALIZATION_POLICY_VERSION } from "../normalization/normalize";
import { createDocumentsFixtureTranslator } from "../normalization/fixtures/documents-fixture-translator";
import type { RawInput } from "../normalization/translator.interface";
import { verifyPinning, type ReplayDeps } from "./registry-pinning";
import {
  auditAccountsOnly,
  auditReplayOutcomes,
  compareManifests,
  manifestsEqual,
} from "./replay-manifest";
import { produceNormalizationReplay, runHistoricalReplay } from "./normalization-replay";
import { orderTimeline } from "./timeline";
import type { ReplayDependencyContext } from "./replay.types";

// --- registries -------------------------------------------------------------

const EVENT_NOMINAL: ConceptValueShape = { mode: "EVENT", scale: "NOMINAL" };
const MEASURE_RATIO: ConceptValueShape = { mode: "MEASURE", scale: "RATIO", unitDimension: "count" };
function def(id: string, ver: string, shape: ConceptValueShape): BusinessConceptDefinition {
  return {
    conceptId: conceptId(id),
    conceptVersion: conceptVersion(ver),
    referentType: shape.mode === "MEASURE" ? "RESOURCE" : "COMMITMENT",
    aspect: shape.mode === "MEASURE" ? "Observed" : "Established",
    valueShape: shape,
    semanticDefinition: `${id}@${ver}`,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
  };
}

const conceptRegistry = buildConceptRegistry([
  def("SalesCommitment", "1", EVENT_NOMINAL),
  def("ResourceLevel", "1", MEASURE_RATIO),
]);
const coverageRegistry = buildCoverageRegistry([
  {
    referentType: "COMMITMENT",
    conceptId: conceptId("SalesCommitment"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: true,
  },
  {
    referentType: "RESOURCE",
    conceptId: conceptId("ResourceLevel"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: false,
  },
] as CoverageEntry[]);

const translator = createDocumentsFixtureTranslator();
const translatorRegistry = buildTranslatorRegistry([
  {
    translatorName: translator.name,
    version: translator.version,
    translatorContractDigest: translator.contractDigest,
    semanticDefinition: "documents fixture",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  },
]);
const engineEpochRegistry = buildEngineEpochRegistry([
  {
    epochId: engineEpochId("brain-engine@1"),
    conceptRegistrySnapshot: conceptRegistry.snapshot.digest,
    executionPolicyVersion: executionPolicyVersion("policy-1"),
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  },
  {
    epochId: engineEpochId("brain-engine@2"),
    conceptRegistrySnapshot: conceptRegistry.snapshot.digest,
    executionPolicyVersion: executionPolicyVersion("policy-2"),
    effectiveFrom: "2026-06-01T00:00:00.000Z",
  },
]);

function makeContext(epoch: string, policy: string): ExecutionContext {
  return {
    engineEpoch: { epochId: engineEpochId(epoch) },
    cotSchemaVersion: cotSchemaVersion("c0-1.2"),
    translatorVersion: { translatorName: translator.name, version: translator.version },
    conceptRegistrySnapshot: conceptRegistry.snapshot.digest,
    executionPolicyVersion: executionPolicyVersion(policy),
  };
}
function makeDepCtx(context: ExecutionContext): ReplayDependencyContext {
  return {
    executionContext: context,
    conceptRegistrySnapshot: conceptRegistry.snapshot.digest,
    coverageRegistrySnapshot: coverageRegistry.snapshot.digest,
    translatorRegistrySnapshot: translatorRegistry.snapshot.digest,
    engineEpochRegistrySnapshot: engineEpochRegistry.snapshot.digest,
    realityTierVocabularyId: fixtureRealityTierValidator.vocabularyId,
    realityTierVocabularyDigest: fixtureRealityTierValidator.vocabularyDigest,
    translatorContractDigest: translator.contractDigest,
    normalizationPolicyVersion: NORMALIZATION_POLICY_VERSION,
  };
}
function makeDeps(context: ExecutionContext): ReplayDeps {
  return {
    translator,
    conceptRegistry,
    coverageRegistry,
    realityTierValidator: fixtureRealityTierValidator,
    context,
    translatorRegistry,
    engineEpochRegistry,
    dependencyContext: makeDepCtx(context),
  };
}

function raw(payload: unknown, sourceRecordId: string, at = "2026-07-02T09:00:00.000Z"): RawInput {
  return {
    ref: { featureDomain: "documents", sourceModel: "Document", sourceRecordId },
    tenant: { businessId: 1 },
    payload,
    observationTime: { at },
  };
}

const ctx1 = makeContext("brain-engine@1", "policy-1");
const deps1 = makeDeps(ctx1);
const INPUTS: readonly RawInput[] = [
  raw({ kind: "happy" }, "doc-1"),
  raw({ kind: "happy" }, "doc-2"),
  raw({ kind: "custom-concept", conceptId: "Ghost" }, "doc-3"),
];

// --- 1. historical replay ×2 → same manifest --------------------------------

const run1 = produceNormalizationReplay(INPUTS, deps1, "HISTORICAL_REPLAY");
assert.equal(run1.pinning.ok, true);
assert.ok(run1.manifest);
const M1 = run1.manifest!;
assert.equal(M1.accountCount, 2);
assert.equal(M1.rejectionCount, 1);
const run1b = produceNormalizationReplay(INPUTS, deps1, "HISTORICAL_REPLAY");
assert.equal(manifestsEqual(M1, run1b.manifest!), true);
assert.equal(M1.manifestDigest, run1b.manifest!.manifestDigest);

// --- 2. input order reversed → same manifest --------------------------------

const runRev = produceNormalizationReplay([...INPUTS].reverse(), deps1, "HISTORICAL_REPLAY");
assert.equal(runRev.manifest!.manifestDigest, M1.manifestDigest);

// --- 3. auditReplayOutcomes(producedOutcomes) → same manifest (round-trip) ---

const rebuilt = auditReplayOutcomes(run1.outcomes, "HISTORICAL_REPLAY", deps1.dependencyContext);
assert.equal(rebuilt.manifestDigest, M1.manifestDigest);

// --- 4. auditAccountsOnly is a narrower manifest (no rejections) -------------

const aa = auditAccountsOnly(run1.outcomes.accounts);
assert.equal(aa.accountCount, 2);
assert.equal(Object.prototype.hasOwnProperty.call(aa, "rejections"), false);
assert.ok(aa.accountsDigest.startsWith("accounts:sha256:"));

// --- 5. manifest carries accounts AND typed rejections ----------------------

assert.equal(M1.accounts.length, 2);
assert.equal(M1.rejections.length, 1);
assert.equal(M1.rejections[0]!.identity.reason, "UNKNOWN_CONCEPT");
assert.ok(M1.rejections[0]!.identityDigest.startsWith("rejectid:sha256:"));
// counts are DERIVED, always consistent
assert.equal(M1.accountCount, M1.accounts.length);
assert.equal(M1.rejectionCount, M1.rejections.length);

// --- 6. same accounts, different rejection payload → different manifest ------

const INPUTS_PHANTOM: readonly RawInput[] = [
  raw({ kind: "happy" }, "doc-1"),
  raw({ kind: "happy" }, "doc-2"),
  raw({ kind: "custom-concept", conceptId: "Phantom" }, "doc-3"),
];
const runPhantom = produceNormalizationReplay(INPUTS_PHANTOM, deps1, "HISTORICAL_REPLAY");
// same 2 accounts...
assert.deepEqual(
  run1.outcomes.accounts.map((a) => a.observationAccountId).sort(),
  runPhantom.outcomes.accounts.map((a) => a.observationAccountId).sort()
);
// ...but a different rejection identity → different manifest
assert.notEqual(runPhantom.manifest!.manifestDigest, M1.manifestDigest);

// --- 7. rejection input order different → same manifest ----------------------

const TWO_REJ: readonly RawInput[] = [
  raw({ kind: "custom-concept", conceptId: "Ghost" }, "doc-3"),
  raw({ kind: "custom-concept", conceptId: "Phantom" }, "doc-4"),
];
const rejA = produceNormalizationReplay(TWO_REJ, deps1, "HISTORICAL_REPLAY");
const rejB = produceNormalizationReplay([...TWO_REJ].reverse(), deps1, "HISTORICAL_REPLAY");
assert.equal(rejA.manifest!.manifestDigest, rejB.manifest!.manifestDigest);
assert.equal(rejA.manifest!.rejectionCount, 2);

// --- 8. dependency pinning matrix -------------------------------------------

const otherConcept = buildConceptRegistry([def("Other", "1", EVENT_NOMINAL)]);
const otherCoverage = buildCoverageRegistry([]);
const otherTranslatorReg = buildTranslatorRegistry([]);
const otherEpochReg = buildEngineEpochRegistry([]);
const sameIdOtherVocab = buildRealityTierValidator(realityTierVocabularyId("fixture-tiers@1"), [
  "tier-observed",
  "tier-EXTRA", // same id, different content
]);
const translatorV2 = createDocumentsFixtureTranslator({ contractVariant: "v2" });

function pin(reason: string, deps: ReplayDeps): void {
  const r = verifyPinning(deps);
  if (r.ok) throw new Error(`expected pinning failure ${reason}, got ok`);
  assert.equal(r.reason, reason);
}
pin("CONCEPT_SNAPSHOT_MISMATCH", { ...deps1, conceptRegistry: otherConcept });
pin("COVERAGE_SNAPSHOT_MISMATCH", { ...deps1, coverageRegistry: otherCoverage });
pin("TRANSLATOR_SNAPSHOT_MISMATCH", { ...deps1, translatorRegistry: otherTranslatorReg });
pin("ENGINE_EPOCH_SNAPSHOT_MISMATCH", { ...deps1, engineEpochRegistry: otherEpochReg });
pin("REALITY_TIER_VOCABULARY_MISMATCH", { ...deps1, realityTierValidator: sameIdOtherVocab });
pin("TRANSLATOR_CONTRACT_MISMATCH", { ...deps1, translator: translatorV2 });
pin("NORMALIZATION_POLICY_MISMATCH", {
  ...deps1,
  dependencyContext: {
    ...deps1.dependencyContext,
    normalizationPolicyVersion: normalizationPolicyVersion("normalize@0"),
  },
});
pin("TRANSLATOR_NOT_REGISTERED", {
  ...deps1,
  context: {
    ...ctx1,
    translatorVersion: { translatorName: translatorName("ghost"), version: translatorVersionTag("1.0.0") },
  },
});
pin("ENGINE_EPOCH_MISSING", {
  ...deps1,
  context: { ...ctx1, engineEpoch: { epochId: engineEpochId("ghost") } },
});
pin("EXECUTION_POLICY_MISMATCH", {
  ...deps1,
  context: { ...ctx1, executionPolicyVersion: executionPolicyVersion("policy-9") },
});
pin("TRANSLATOR_VERSION_MISMATCH", {
  ...deps1,
  context: {
    ...ctx1,
    translatorVersion: { translatorName: translator.name, version: translatorVersionTag("9.9.9") },
  },
});
const badEpochReg = buildEngineEpochRegistry([
  {
    epochId: engineEpochId("brain-engine@bad"),
    conceptRegistrySnapshot: otherConcept.snapshot.digest, // != context concept snapshot
    executionPolicyVersion: executionPolicyVersion("policy-1"),
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  },
]);
pin("ENGINE_EPOCH_CONCEPT_SNAPSHOT_MISMATCH", {
  ...deps1,
  engineEpochRegistry: badEpochReg,
  context: { ...ctx1, engineEpoch: { epochId: engineEpochId("brain-engine@bad") } },
  dependencyContext: {
    ...deps1.dependencyContext,
    engineEpochRegistrySnapshot: badEpochReg.snapshot.digest,
  },
});

// manifest is NOT built when pinning fails
const badRun = produceNormalizationReplay(INPUTS, { ...deps1, coverageRegistry: otherCoverage }, "LIVE_NORMALIZE");
assert.equal(badRun.pinning.ok, false);
assert.equal(badRun.manifest, undefined);

// --- 9-10. historical replay vs expected baseline ---------------------------

const matched = runHistoricalReplay(INPUTS, deps1, M1);
assert.equal(matched.comparison?.ok, true);

const diverged = runHistoricalReplay([raw({ kind: "happy" }, "doc-1")], deps1, M1);
assert.equal(diverged.comparison?.ok, false);
if (diverged.comparison && !diverged.comparison.ok) {
  const d = diverged.comparison.divergence;
  assert.ok(d.missingAccounts.length >= 1); // doc-2 account absent
  assert.ok(d.missingRejections.length >= 1); // doc-3 rejection absent
}

// --- 11. REPROCESS_NEW_EPOCH → sibling accounts (same source, new account) ---

const ctx2 = makeContext("brain-engine@2", "policy-2");
const deps2 = makeDeps(ctx2);
const run2 = produceNormalizationReplay(INPUTS, deps2, "REPROCESS_NEW_EPOCH");
assert.equal(run2.pinning.ok, true);
const bySource1 = new Map(run1.outcomes.accounts.map((a) => [a.sourceObservationId, a.observationAccountId]));
for (const a2 of run2.outcomes.accounts) {
  assert.equal(bySource1.has(a2.sourceObservationId), true); // same logical source
  assert.notEqual(bySource1.get(a2.sourceObservationId), a2.observationAccountId); // NEW account (sibling)
}
assert.notEqual(run2.manifest!.manifestDigest, M1.manifestDigest); // not the historical manifest

// --- 12. inference freeze: same runId → same account; new runId → new account -

const infA = produceNormalizationReplay([raw({ kind: "inference", runId: "r1", datum: 5 }, "inf-1")], deps1, "HISTORICAL_REPLAY");
const infA2 = produceNormalizationReplay([raw({ kind: "inference", runId: "r1", datum: 5 }, "inf-1")], deps1, "HISTORICAL_REPLAY");
const infB = produceNormalizationReplay([raw({ kind: "inference", runId: "r2", datum: 5 }, "inf-1")], deps1, "HISTORICAL_REPLAY");
assert.equal(infA.outcomes.accounts[0]!.observationAccountId, infA2.outcomes.accounts[0]!.observationAccountId);
assert.notEqual(infA.outcomes.accounts[0]!.observationAccountId, infB.outcomes.accounts[0]!.observationAccountId);
assert.equal(infA.outcomes.accounts[0]!.sourceObservationId, infB.outcomes.accounts[0]!.sourceObservationId);

// --- 13. timeline ordering (instant < interval < unknown-partition) ---------

const onlyAcc = (inp: RawInput) =>
  produceNormalizationReplay([inp], deps1, "LIVE_NORMALIZE").outcomes.accounts[0]!;
const instantAcc = onlyAcc(raw({ kind: "happy" }, "t-instant"));
const intervalAcc = onlyAcc(raw({ kind: "event-interval" }, "t-interval"));
const unknownAcc = onlyAcc(raw({ kind: "event-unknown" }, "t-unknown"));
const tl = orderTimeline([unknownAcc, intervalAcc, instantAcc]); // deliberately scrambled
assert.equal(tl[0]!.observationAccountId, instantAcc.observationAccountId); // 2026-07-01
assert.equal(tl[1]!.observationAccountId, intervalAcc.observationAccountId); // 2026-07-02
assert.equal(tl[2]!.observationAccountId, unknownAcc.observationAccountId); // UNKNOWN partition last
assert.equal(tl[0]!.temporalBasis, "EVENT_TIME");
assert.equal(tl[1]!.temporalBasis, "EVENT_TIME");
assert.equal(tl[2]!.temporalBasis, "UNKNOWN"); // no silent event-time fallback

// --- 14. GOLDEN Replay Manifest digest --------------------------------------

// Hard-coded expected manifest digest — NOT recomputed by the code under test.
// Regenerate ONLY via an explicit, reviewed change (it pins dependency context,
// account identities, ordered rejections, and their typed identity payloads).
const EXPECTED_REPLAY_MANIFEST_DIGEST =
  "replaymanifest:sha256:443cf151d72b4a2f32f25e437472aed7b4259fdb0903490438636c7fb1193f1c";
assert.equal(M1.manifestDigest, EXPECTED_REPLAY_MANIFEST_DIGEST);

console.log("C0 replay (PR4) tests: OK");
