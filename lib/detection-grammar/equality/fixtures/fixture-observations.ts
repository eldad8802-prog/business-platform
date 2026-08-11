/**
 * Fixture C0 CanonicalObservation accounts (PROOF ONLY).
 *
 * Produced via C0's own sealObservation() account-sealing contract, so each is a
 * genuine immutable, deep-frozen account with real derived identity
 * (sourceObservationId / canonicalHash / observationAccountId). This proof consumes
 * real C0 accounts.
 *
 * IMPLEMENTATION-ONLY choice (reported): the proof uses sealObservation() rather
 * than the full Normalize pipeline (translator / registries / coverage). Normalize's
 * correctness is C0's own concern (verify:brain-normalize); the Equality proof only
 * needs sealed accounts, which sealObservation provides. The ExecutionContext uses
 * pinned fixture identities and a placeholder concept-snapshot digest; no registry is
 * consulted, because sealObservation does not normalize. NO C0 file is modified.
 */
import { sealObservation } from "../../../business-brain/observation-identity";
import type {
  CanonicalObservation,
  ObservationContent,
} from "../../../business-brain/observation.types";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
  translatorName,
  translatorVersionTag,
} from "../../../business-brain/versioning.types";
import type { RegistrySnapshotDigest } from "../../../business-brain/versioning.types";

// Fixture-only pinned snapshot digest. sealObservation() never validates it; it is
// pinned solely so the ExecutionContext (part of canonicalHash) is stable/replayable.
const FIXTURE_CONCEPT_SNAPSHOT = ("regsnap:concept:sha256:" +
  "0".repeat(64)) as RegistrySnapshotDigest;

function baseContent(
  datum: string | number,
  sourceRecordId: string
): ObservationContent {
  return {
    tenant: { businessId: 1 },
    source: {
      featureDomain: "fixture",
      sourceModel: "FixtureIntegerSensor",
      sourceRecordId,
      emittedObservationIndex: 0,
    },
    concept: {
      conceptId: conceptId("fixture.integer.reading"),
      conceptVersion: conceptVersion("1"),
    },
    referent: {
      referentType: "RESOURCE",
      identityBinding: { kind: "UNRESOLVED", reason: "NOT_OBSERVED" },
    },
    value: { scale: "CARDINAL", datum, unit: null },
    mode: "MEASURE",
    eventTime: { kind: "UNKNOWN", reason: "NOT_OBSERVED" },
    observationTime: { at: "2026-01-01T00:00:00.000Z" },
    provenance: {
      realityTier: "fixture-tier",
      authentication: "SELF_ASSERTED",
      channel: "fixture",
    },
    completeness: { kind: "COMPLETE" },
    coverage: {
      state: "FULL",
      sensorState: { sensorId: "fixture-sensor", declared: "ACTIVE" },
      absenceInformative: false,
      scopeRef: "fixture-scope",
    },
    confidenceBasis: {},
    context: {
      engineEpoch: { epochId: engineEpochId("fixture-epoch@1") },
      cotSchemaVersion: cotSchemaVersion("cot@1"),
      translatorVersion: {
        translatorName: translatorName("fixture-translator"),
        version: translatorVersionTag("1"),
      },
      conceptRegistrySnapshot: FIXTURE_CONCEPT_SNAPSHOT,
      executionPolicyVersion: executionPolicyVersion("exec@1"),
    },
  };
}

/** Seal a fixture C0 observation carrying `datum` as its canonical value. */
export function fixtureObservation(
  datum: string | number,
  sourceRecordId: string
): CanonicalObservation {
  return sealObservation(baseContent(datum, sourceRecordId));
}
