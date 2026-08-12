/**
 * RIA — Cross-Feature C0 Fixture (PROOF ONLY) · genuine C0 Normalize pipeline.
 *
 * Runs fixture RawInputs from TWO different Feature Domains (documents, inventory)
 * through C0's REAL normalize() — the fixture translator, versioned concept registry,
 * coverage registry, reality-tier validator — producing sealed CanonicalObservations
 * pinned to a REAL registry snapshot digest (minted by buildConceptRegistry). It does
 * NOT duplicate normalization logic and modifies NO C0 file. Fixtures-only; no DB, no
 * persistence, no product wiring.
 *
 * Two concepts are registered:
 *   • ResourceLevel@1 (MEASURE/RATIO/count) — the cross-feature RESOURCE scenario.
 *   • SalesCommitment@1 (EVENT/NOMINAL) — a PARTY-referent observation for the type-
 *     isolation scenario (X7). Both are canonical shapes copied from the C0 seed.
 * Coverage is declared for both feature domains so an inventory-sourced observation is
 * a first-class C0 account, exactly like a documents-sourced one.
 */
import {
  buildConceptRegistry,
  type BusinessConceptDefinition,
} from "../../business-brain/registry/concept-registry";
import {
  buildCoverageRegistry,
  type CoverageEntry,
} from "../../business-brain/registry/coverage-registry";
import { fixtureRealityTierValidator } from "../../business-brain/normalization/reality-tier-registry";
import { normalize, type NormalizeDeps } from "../../business-brain/normalization/normalize";
import {
  createDocumentsFixtureTranslator,
  type FixtureScenario,
} from "../../business-brain/normalization/fixtures/documents-fixture-translator";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
  translatorName,
  translatorVersionTag,
} from "../../business-brain/versioning.types";
import type {
  CanonicalObservation,
  ExecutionContext,
} from "../../business-brain/observation.types";
import type { RawInput } from "../../business-brain/normalization/translator.interface";

// ── Concepts (canonical shapes, copied from the C0 seed — not invented here) ──
const RESOURCE_LEVEL: BusinessConceptDefinition = {
  conceptId: conceptId("ResourceLevel"),
  conceptVersion: conceptVersion("1"),
  referentType: "RESOURCE",
  aspect: "Observed",
  valueShape: { mode: "MEASURE", scale: "RATIO", unitDimension: "count" },
  semanticDefinition: "ResourceLevel@1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
};

const SALES_COMMITMENT: BusinessConceptDefinition = {
  conceptId: conceptId("SalesCommitment"),
  conceptVersion: conceptVersion("1"),
  referentType: "COMMITMENT",
  aspect: "Established",
  valueShape: { mode: "EVENT", scale: "NOMINAL" },
  semanticDefinition: "SalesCommitment@1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
};

const conceptRegistry = buildConceptRegistry([RESOURCE_LEVEL, SALES_COMMITMENT]);

const coverageRegistry = buildCoverageRegistry([
  {
    referentType: "RESOURCE",
    conceptId: conceptId("ResourceLevel"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: false,
  },
  {
    referentType: "RESOURCE",
    conceptId: conceptId("ResourceLevel"),
    sourceSensor: "inventory",
    coverageState: "FULL",
    sensorState: { sensorId: "inventory", declared: "ACTIVE" },
    absenceInformative: false,
  },
  {
    referentType: "PARTY",
    conceptId: conceptId("SalesCommitment"),
    sourceSensor: "documents",
    coverageState: "FULL",
    sensorState: { sensorId: "documents", declared: "ACTIVE" },
    absenceInformative: false,
  },
] as CoverageEntry[]);

/** The REAL concept-registry snapshot digest, pinned into the ExecutionContext. */
export const CROSS_FEATURE_CONCEPT_SNAPSHOT = conceptRegistry.snapshot.digest;

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

function runSingle(input: RawInput, label: string): CanonicalObservation {
  const results = normalize(input, deps);
  const first = results[0];
  if (results.length !== 1 || first === undefined || !first.ok) {
    throw new Error(
      `RIA fixture (${label}): normalize() did not yield a single sealed account: ${JSON.stringify(results)}`
    );
  }
  return first.observation;
}

export interface ResourceObservationOpts {
  readonly featureDomain: string;
  readonly datum: number;
  readonly sourceRecordId: string;
  readonly runId: string;
  readonly businessId?: number;
}

/** A RESOURCE/ResourceLevel observation from a given feature domain (genuine C0). */
export function normalizeResourceObservation(
  opts: ResourceObservationOpts
): CanonicalObservation {
  const scenario: FixtureScenario = { kind: "inference", runId: opts.runId, datum: opts.datum };
  const input: RawInput = {
    ref: {
      featureDomain: opts.featureDomain,
      sourceModel: "FixtureIntegerSensor",
      sourceRecordId: opts.sourceRecordId,
    },
    tenant: { businessId: opts.businessId ?? 1 },
    payload: scenario,
    observationTime: { at: "2026-07-01T00:00:00.000Z" },
  };
  return runSingle(input, `resource:${opts.featureDomain}`);
}

export interface PartyObservationOpts {
  readonly featureDomain: string;
  readonly sourceRecordId: string;
  readonly label: string;
  readonly businessId?: number;
}

/** A PARTY-referent observation (SalesCommitment via free-text id) for type isolation. */
export function normalizePartyObservation(
  opts: PartyObservationOpts
): CanonicalObservation {
  const scenario: FixtureScenario = { kind: "free-text-id", label: opts.label };
  const input: RawInput = {
    ref: {
      featureDomain: opts.featureDomain,
      sourceModel: "FixturePartySensor",
      sourceRecordId: opts.sourceRecordId,
    },
    tenant: { businessId: opts.businessId ?? 1 },
    payload: scenario,
    observationTime: { at: "2026-07-01T00:00:00.000Z" },
  };
  return runSingle(input, `party:${opts.featureDomain}`);
}
