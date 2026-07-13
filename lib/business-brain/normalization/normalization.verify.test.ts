/**
 * C0 / PR3 — Normalize verification.
 * Run with:  npx tsx lib/business-brain/normalization/normalization.verify.test.ts
 * (or: npm run verify:brain-normalize)
 *
 * Pure logic only — no DB, no SoT, no runtime, no replay. Exercises the full
 * pipeline over fixtures: version selection, value-shape, provenance, coverage,
 * identity, typed rejections, idempotency, fan-out, and cross-tenant isolation.
 */
import assert from "node:assert/strict";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
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
import { fixtureRealityTierValidator } from "./reality-tier-registry";
import { normalize, type NormalizeDeps } from "./normalize";
import {
  createDocumentsFixtureTranslator,
  type FixtureScenario,
} from "./fixtures/documents-fixture-translator";
import type { NormalizationResult } from "./normalization-result.types";
import type { RawInput } from "./translator.interface";

// --- registries -------------------------------------------------------------

const EVENT_NOMINAL: ConceptValueShape = { mode: "EVENT", scale: "NOMINAL" };
const MEASURE_RATIO: ConceptValueShape = { mode: "MEASURE", scale: "RATIO", unitDimension: "count" };

function def(
  id: string,
  ver: string,
  from: string,
  to: string | null,
  shape: ConceptValueShape
): BusinessConceptDefinition {
  return {
    conceptId: conceptId(id),
    conceptVersion: conceptVersion(ver),
    referentType: shape.mode === "MEASURE" ? "RESOURCE" : "COMMITMENT",
    aspect: shape.mode === "MEASURE" ? "Observed" : "Established",
    valueShape: shape,
    semanticDefinition: `${id}@${ver}`,
    effectiveFrom: from,
    effectiveTo: to,
  };
}

const conceptRegistry = buildConceptRegistry([
  def("SalesCommitment", "1", "2026-01-01T00:00:00.000Z", null, EVENT_NOMINAL),
  def("ResourceLevel", "1", "2026-01-01T00:00:00.000Z", null, MEASURE_RATIO),
  def("Timed", "1", "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", EVENT_NOMINAL),
  def("Timed", "2", "2026-06-01T00:00:00.000Z", null, EVENT_NOMINAL),
  def("Overlap", "1", "2026-01-01T00:00:00.000Z", null, EVENT_NOMINAL),
  def("Overlap", "2", "2026-01-01T00:00:00.000Z", null, EVENT_NOMINAL),
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
    referentType: "PARTY",
    conceptId: conceptId("SalesCommitment"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: true,
  },
  {
    referentType: "COMMITMENT",
    conceptId: conceptId("Timed"),
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
  {
    referentType: "COMMITMENT",
    conceptId: conceptId("SalesCommitment"),
    sourceSensor: "inactive-sensor",
    coverageState: "FULL",
    sensorState: { sensorId: "inactive-sensor", declared: "INACTIVE" },
    absenceInformative: false,
  },
  {
    referentType: "COMMITMENT",
    conceptId: conceptId("SalesCommitment"),
    sourceSensor: "declared-uncovered-sensor",
    coverageState: "UNCOVERED",
    sensorState: { sensorId: "declared-uncovered-sensor", declared: "INACTIVE" },
    absenceInformative: false,
  },
] as CoverageEntry[]);

const context: ExecutionContext = {
  engineEpoch: { epochId: engineEpochId("brain-engine@1") },
  cotSchemaVersion: cotSchemaVersion("c0-1.2"),
  translatorVersion: {
    translatorName: translatorName("documents-normalize"),
    version: translatorVersionTag("1.0.0"),
  },
  conceptRegistrySnapshot: conceptRegistry.snapshot.digest,
  executionPolicyVersion: executionPolicyVersion("policy-1"),
};

const deps: NormalizeDeps = {
  translator: createDocumentsFixtureTranslator(),
  conceptRegistry,
  coverageRegistry,
  realityTierValidator: fixtureRealityTierValidator,
  context,
};

// --- runner + assertions helpers -------------------------------------------

function run(
  scenario: FixtureScenario,
  opts?: { observationTime?: string; businessId?: number; sourceRecordId?: string },
  d: NormalizeDeps = deps
): readonly NormalizationResult[] {
  const input: RawInput = {
    ref: {
      featureDomain: "documents",
      sourceModel: "Document",
      sourceRecordId: opts?.sourceRecordId ?? "doc-1",
    },
    tenant: { businessId: opts?.businessId ?? 1 },
    payload: scenario,
    observationTime: { at: opts?.observationTime ?? "2026-07-02T09:00:00.000Z" },
  };
  return normalize(input, d);
}

function okAt(results: readonly NormalizationResult[], idx = 0) {
  const r = results[idx]!;
  if (!r.ok) throw new Error(`expected ok, got failure: ${r.reason}`);
  return r.observation;
}
function fail(results: readonly NormalizationResult[], reason: string) {
  const r = results[0]!;
  if (r.ok) throw new Error("expected failure, got ok");
  assert.equal(r.reason, reason);
}

// --- happy path -------------------------------------------------------------

const happy = okAt(run({ kind: "happy" }));
assert.equal(happy.concept.conceptId, "SalesCommitment");
assert.equal(happy.concept.conceptVersion, "1");
assert.equal(happy.coverage.state, "FULL");
assert.equal(happy.coverage.sensorState.declared, "ACTIVE");
assert.equal(happy.coverage.absenceInformative, true);

// --- concept resolution failures -------------------------------------------

fail(run({ kind: "custom-concept", conceptId: "Ghost" }), "UNKNOWN_CONCEPT");
fail(
  run({ kind: "custom-concept", conceptId: "SalesCommitment", requestedConceptVersion: "9" }),
  "UNKNOWN_CONCEPT_VERSION"
);
fail(
  run(
    { kind: "custom-concept", conceptId: "Timed", requestedConceptVersion: "1" },
    { observationTime: "2026-08-01T00:00:00.000Z" }
  ),
  "REQUESTED_CONCEPT_VERSION_NOT_EFFECTIVE"
);
fail(
  run({ kind: "custom-concept", conceptId: "Timed" }, { observationTime: "2025-01-01T00:00:00.000Z" }),
  "NO_EFFECTIVE_CONCEPT_VERSION"
);
fail(run({ kind: "custom-concept", conceptId: "Overlap" }), "CONCEPT_VERSION_AMBIGUOUS");

// --- time-based version selection ------------------------------------------

assert.equal(
  okAt(run({ kind: "custom-concept", conceptId: "Timed" }, { observationTime: "2026-03-01T00:00:00.000Z" })).concept.conceptVersion,
  "1"
);
assert.equal(
  okAt(run({ kind: "custom-concept", conceptId: "Timed" }, { observationTime: "2026-08-01T00:00:00.000Z" })).concept.conceptVersion,
  "2"
);

// --- value shape / required field ------------------------------------------

fail(run({ kind: "value-shape-mismatch" }), "VALUE_SHAPE_MISMATCH");
fail(run({ kind: "missing-field" }), "MISSING_REQUIRED_FIELD");

// --- completeness / identity ------------------------------------------------

assert.equal(okAt(run({ kind: "partial", missing: ["date"] })).completeness.kind, "PARTIAL");

const unresolved = okAt(run({ kind: "unresolved-id" }));
assert.equal(unresolved.referent.identityBinding.kind, "UNRESOLVED");

const freeText = okAt(run({ kind: "free-text-id", label: "ACME Ltd" }));
assert.equal(freeText.referent.identityBinding.kind, "SIGNAL_ONLY");
if (freeText.referent.identityBinding.kind === "SIGNAL_ONLY") {
  assert.equal(freeText.referent.identityBinding.signalType, "free-text");
  assert.equal(freeText.referent.identityBinding.signalValue, "ACME Ltd");
}

// --- coverage grounds (no T1/T2/T3, no inference of absenceInformative) -----

const inactive = okAt(run({ kind: "sensor-inactive" }));
assert.equal(inactive.coverage.sensorState.declared, "INACTIVE"); // declared state verbatim
assert.equal(inactive.coverage.state, "FULL"); // real record → still Evidence
assert.equal(inactive.coverage.absenceInformative, false); // verbatim, never inferred

// EXPLICIT UNCOVERED entry → valid COT carrying honest coverage grounds
const declaredUncovered = okAt(run({ kind: "declared-uncovered" }));
assert.equal(declaredUncovered.coverage.state, "UNCOVERED");
assert.equal(declaredUncovered.coverage.absenceInformative, false);

// MISSING coverage entry (NO_ENTRY) → typed rejection, NO fabricated COT
fail(run({ kind: "missing-coverage" }), "COVERAGE_ENTRY_MISSING");

// --- field provenance preserved verbatim (no laundering/upgrade) -----------

const fp = okAt(run({ kind: "field-provenance" }));
assert.deepEqual(fp.provenance.fieldProvenance, [
  { field: "amount", realityTier: "tier-observed", channel: "documents" },
]);
assert.equal(fp.provenance.realityTier, "tier-observed"); // record-level unchanged

// --- provenance failures ----------------------------------------------------

fail(run({ kind: "bad-reality-tier" }), "INVALID_REALITY_TIER");
fail(run({ kind: "channel-laundering" }), "CHANNEL_LAUNDERING");

// --- inference: Account = the run, not the value ----------------------------

const runA = okAt(run({ kind: "inference", runId: "run-A", datum: 10 }));
const runA2 = okAt(run({ kind: "inference", runId: "run-A", datum: 10 }));
const runB = okAt(run({ kind: "inference", runId: "run-B", datum: 10 }));
assert.equal(runA.observationAccountId, runA2.observationAccountId); // same run → dedup
assert.notEqual(runA.observationAccountId, runB.observationAccountId); // new run → new account
assert.equal(runA.sourceObservationId, runB.sourceObservationId); // one logical source slot

// --- late-arriving event ----------------------------------------------------

const late = okAt(run({ kind: "happy" }, { observationTime: "2026-12-01T00:00:00.000Z" }));
assert.equal(late.eventTime.kind, "INSTANT");
if (late.eventTime.kind === "INSTANT") {
  assert.equal(late.eventTime.at, "2026-07-01T00:00:00.000Z"); // old world time preserved
}
assert.equal(late.observationTime.at, "2026-12-01T00:00:00.000Z"); // new ingest time

// --- fan-out + shared causeRef correlation ----------------------------------

const fan = run({ kind: "fan-out" });
assert.equal(fan.length, 2);
const fan0 = okAt(fan, 0);
const fan1 = okAt(fan, 1);
assert.notEqual(fan0.sourceObservationId, fan1.sourceObservationId);
assert.equal(fan0.causeRef?.note, "originating-action:doc-1");
assert.equal(fan0.causeRef?.note, fan1.causeRef?.note);

// --- process instance chain -------------------------------------------------

const proc = okAt(run({ kind: "process-chain", instanceId: "inv-777" }));
assert.equal(proc.processInstanceRef?.instanceId, "inv-777");

// --- retry idempotency / deterministic output -------------------------------

const r1 = okAt(run({ kind: "happy" }));
const r2 = okAt(run({ kind: "happy" }));
assert.equal(r1.observationAccountId, r2.observationAccountId);
assert.equal(r1.canonicalHash, r2.canonicalHash);

// --- snapshot pinning -------------------------------------------------------

const otherRegistry = buildConceptRegistry([
  def("Other", "1", "2026-01-01T00:00:00.000Z", null, EVENT_NOMINAL),
]);
const mismatchedDeps: NormalizeDeps = {
  ...deps,
  context: { ...context, conceptRegistrySnapshot: otherRegistry.snapshot.digest },
};
fail(run({ kind: "happy" }, undefined, mismatchedDeps), "SNAPSHOT_MISMATCH");

// --- cross-tenant isolation -------------------------------------------------

const t1 = okAt(run({ kind: "happy" }, { businessId: 1 }));
const t2 = okAt(run({ kind: "happy" }, { businessId: 2 }));
assert.notEqual(t1.sourceObservationId, t2.sourceObservationId);

console.log("C0 normalization (PR3) tests: OK");
