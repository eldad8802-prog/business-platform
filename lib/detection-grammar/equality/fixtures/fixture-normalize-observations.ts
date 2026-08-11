/**
 * H1 HARDENING FIXTURE (PROOF ONLY) — genuine C0 Normalize pipeline.
 *
 * Unlike fixture-observations.ts (which seals accounts directly via C0
 * sealObservation), this fixture runs a RawInput through C0's REAL normalize()
 * pipeline — the fixture translator, versioned concept registry, coverage registry,
 * reality-tier validator — producing a sealed CanonicalObservation the same way the
 * C0 verify suite does. The ExecutionContext is pinned to a REAL registry snapshot
 * digest minted by C0's buildConceptRegistry() (buildSnapshot mechanism), NOT a
 * placeholder cast.
 *
 * This does NOT duplicate normalization logic: it only configures registries and
 * calls the genuine C0 normalize(). No C0 file is modified. Fixtures-only; no DB, no
 * persistence, no product wiring.
 */
import {
  buildConceptRegistry,
  type BusinessConceptDefinition,
  type ConceptValueShape,
} from "../../../business-brain/registry/concept-registry";
import {
  buildCoverageRegistry,
  type CoverageEntry,
} from "../../../business-brain/registry/coverage-registry";
import { fixtureRealityTierValidator } from "../../../business-brain/normalization/reality-tier-registry";
import { normalize, type NormalizeDeps } from "../../../business-brain/normalization/normalize";
import {
  createDocumentsFixtureTranslator,
  type FixtureScenario,
} from "../../../business-brain/normalization/fixtures/documents-fixture-translator";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
  translatorName,
  translatorVersionTag,
} from "../../../business-brain/versioning.types";
import type { CanonicalObservation, ExecutionContext } from "../../../business-brain/observation.types";
import type { RawInput } from "../../../business-brain/normalization/translator.interface";

const MEASURE_RATIO_COUNT: ConceptValueShape = {
  mode: "MEASURE",
  scale: "RATIO",
  unitDimension: "count",
};

// A single versioned world-concept whose RATIO value carries an integer datum.
const RESOURCE_LEVEL: BusinessConceptDefinition = {
  conceptId: conceptId("ResourceLevel"),
  conceptVersion: conceptVersion("1"),
  referentType: "RESOURCE",
  aspect: "Observed",
  valueShape: MEASURE_RATIO_COUNT,
  semanticDefinition: "ResourceLevel@1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
};

const conceptRegistry = buildConceptRegistry([RESOURCE_LEVEL]);

const coverageRegistry = buildCoverageRegistry([
  {
    referentType: "RESOURCE",
    conceptId: conceptId("ResourceLevel"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: false,
  },
] as CoverageEntry[]);

/** The REAL concept-registry snapshot digest (minted by buildConceptRegistry ->
 *  buildSnapshot), pinned into the ExecutionContext. Exported so the proof can
 *  assert the account is pinned to it and is NOT the placeholder. */
export const H1_REAL_CONCEPT_SNAPSHOT = conceptRegistry.snapshot.digest;

const context: ExecutionContext = {
  engineEpoch: { epochId: engineEpochId("brain-engine@1") },
  cotSchemaVersion: cotSchemaVersion("c0-1.2"),
  translatorVersion: {
    translatorName: translatorName("documents-normalize"),
    version: translatorVersionTag("1.0.0"),
  },
  conceptRegistrySnapshot: conceptRegistry.snapshot.digest, // REAL digest, no cast
  executionPolicyVersion: executionPolicyVersion("policy-1"),
};

const deps: NormalizeDeps = {
  translator: createDocumentsFixtureTranslator(),
  conceptRegistry,
  coverageRegistry,
  realityTierValidator: fixtureRealityTierValidator,
  context,
};

/**
 * Run a fixture RawInput through the genuine C0 normalize() pipeline and return the
 * single sealed CanonicalObservation. `datum` is the integer carried by the RATIO
 * value; `runId` is identity-bearing, so a fixed runId makes the account replayable.
 */
export function normalizeIntegerObservation(
  datum: number,
  sourceRecordId: string,
  runId: string
): CanonicalObservation {
  const scenario: FixtureScenario = { kind: "inference", runId, datum };
  const input: RawInput = {
    ref: { featureDomain: "documents", sourceModel: "FixtureIntegerSensor", sourceRecordId },
    tenant: { businessId: 1 },
    payload: scenario,
    observationTime: { at: "2026-07-01T00:00:00.000Z" },
  };
  const results = normalize(input, deps);
  const first = results[0];
  if (results.length !== 1 || first === undefined || !first.ok) {
    throw new Error(
      `H1 fixture: normalize() did not yield a single sealed account: ${JSON.stringify(results)}`
    );
  }
  return first.observation;
}
