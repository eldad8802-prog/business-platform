/**
 * C0 (Canonical Observation Model) — identity & immutability verification.
 * Run with:  npx tsx lib/business-brain/observation-identity.verify.test.ts
 * (or: npm run verify:brain-c0)
 *
 * Pure logic only — no database, no UI, no HTTP. Proves the C0 v1.2 contracts:
 * source vs account identity, immutable append-only siblings, determinism,
 * retry idempotency, fan-out, and Account = the observation/inference act.
 */
import assert from "node:assert/strict";
import { BrainError } from "./brain-error";
import { canonicalize } from "./canonical-serialize";
import { sealObservation } from "./observation-identity";
import type { ObservationContent } from "./observation.types";
import {
  conceptId,
  conceptVersion,
  cotSchemaVersion,
  engineEpochId,
  executionPolicyVersion,
  translatorName,
  translatorVersionTag,
} from "./versioning.types";
import { parseSnapshotDigest } from "./registry/registry-snapshot";
import { buildConceptRegistry } from "./registry/concept-registry";
import { SEED_CONCEPTS } from "./registry/seed/concepts.seed";

// A real snapshot digest (branded values are only minted by buildSnapshot).
const SNAP_DIGEST = buildConceptRegistry(SEED_CONCEPTS).snapshot.digest;

// --- fixture ---------------------------------------------------------------

function content(overrides: Partial<ObservationContent> = {}): ObservationContent {
  const base: ObservationContent = {
    tenant: { businessId: 1 },
    source: {
      featureDomain: "documents",
      sourceModel: "Document",
      sourceRecordId: "doc-42",
      emittedObservationIndex: 0,
    },
    concept: { conceptId: conceptId("invoice.amount"), conceptVersion: conceptVersion("1") },
    referent: {
      referentType: "COMMITMENT",
      identityBinding: {
        kind: "RESOLVED",
        entityType: "BillingDocument",
        entityId: 42,
        resolutionMethod: "DETERMINISTIC_EXACT",
      },
    },
    value: { scale: "RATIO", datum: 1000, unit: "ILS" },
    mode: "MEASURE",
    eventTime: { kind: "INSTANT", at: "2026-07-01T00:00:00.000Z" },
    observationTime: { at: "2026-07-02T09:00:00.000Z" },
    provenance: {
      realityTier: "tier-observed",
      authentication: "AUTHENTICATED",
      channel: "gmail",
    },
    completeness: { kind: "COMPLETE" },
    coverage: {
      state: "FULL",
      sensorState: { sensorId: "gmail", declared: "ACTIVE" },
      absenceInformative: false,
      scopeRef: "doc-42",
    },
    confidenceBasis: {},
    context: {
      engineEpoch: { epochId: engineEpochId("epoch-1") },
      cotSchemaVersion: cotSchemaVersion("c0-1.2"),
      translatorVersion: {
        translatorName: translatorName("documents-normalize"),
        version: translatorVersionTag("1.0.0"),
      },
      conceptRegistrySnapshot: SNAP_DIGEST,
      executionPolicyVersion: executionPolicyVersion("policy-1"),
    },
  };
  return { ...base, ...overrides };
}

// --- canonicalize determinism ----------------------------------------------

// Key insertion order must not affect output.
assert.equal(
  canonicalize({ a: 1, b: 2, c: 3 }),
  canonicalize({ c: 3, b: 2, a: 1 })
);
// undefined properties are stripped; {a:1} ≡ {a:1,b:undefined}.
assert.equal(canonicalize({ a: 1 }), canonicalize({ a: 1, b: undefined }));
// arrays preserve order (order is content).
assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));

// --- source vs content identity (Delta §3-4) -------------------------------

const base = sealObservation(content());

// Changing CONTEXT (epoch) → same source slot, new content, new account.
const epochBump = sealObservation(
  content({
    context: { ...content().context, engineEpoch: { epochId: engineEpochId("epoch-2") } },
  })
);
assert.equal(base.sourceObservationId, epochBump.sourceObservationId);
assert.notEqual(base.canonicalHash, epochBump.canonicalHash);
assert.notEqual(base.observationAccountId, epochBump.observationAccountId);

// Changing VALUE (content) → same source slot, new account (append sibling).
const valueChange = sealObservation(
  content({ value: { scale: "RATIO", datum: 1002, unit: "ILS" } })
);
assert.equal(base.sourceObservationId, valueChange.sourceObservationId);
assert.notEqual(base.canonicalHash, valueChange.canonicalHash);
assert.notEqual(base.observationAccountId, valueChange.observationAccountId);

// --- deterministic translator VERSION bump (v1.2) --------------------------
// Stable translatorName unchanged, version changed → same source slot, new
// account. Version is content (canonicalHash), NOT source identity.
const translatorBump = sealObservation(
  content({
    context: {
      ...content().context,
      translatorVersion: {
        translatorName: translatorName("documents-normalize"),
        version: translatorVersionTag("2.0.0"),
      },
    },
  })
);
assert.equal(base.sourceObservationId, translatorBump.sourceObservationId);
assert.notEqual(base.observationAccountId, translatorBump.observationAccountId);

// --- retry idempotency / determinism ---------------------------------------
// Identical content sealed again → identical ids (no new account on retry).
const retry = sealObservation(content());
assert.equal(base.sourceObservationId, retry.sourceObservationId);
assert.equal(base.canonicalHash, retry.canonicalHash);
assert.equal(base.observationAccountId, retry.observationAccountId);

// --- fan-out (emittedObservationIndex) -------------------------------------
// Two observations from one source record → distinct source slots + accounts.
const fanOut = sealObservation(
  content({ source: { ...content().source, emittedObservationIndex: 1 } })
);
assert.notEqual(base.sourceObservationId, fanOut.sourceObservationId);
assert.notEqual(base.observationAccountId, fanOut.observationAccountId);

// --- Account = the inference ACT, not the value (Correction Patch) ---------

function inferred(runId: string, datum: number): ObservationContent {
  return content({
    value: { scale: "RATIO", datum, unit: "ILS" },
    provenance: {
      realityTier: "tier-inferred",
      authentication: "THIRD_PARTY",
      channel: "gmail",
      inference: {
        engine: "google-vision",
        engineVersion: "textDetection-v1",
        runId,
        nonDeterministic: true,
      },
    },
  });
}

const runA1000 = sealObservation(inferred("run-A", 1000));
const runA1000b = sealObservation(inferred("run-A", 1000)); // same run, same output
const runB1000 = sealObservation(inferred("run-B", 1000)); // new run, same output
const runC1002 = sealObservation(inferred("run-C", 1002)); // new run, diff output

// same runId + same output → same account (technical retry dedup).
assert.equal(runA1000.observationAccountId, runA1000b.observationAccountId);
// different runId + same output → DIFFERENT accounts (two inference acts).
assert.notEqual(runA1000.observationAccountId, runB1000.observationAccountId);
// different runId + different output → different accounts.
assert.notEqual(runB1000.observationAccountId, runC1002.observationAccountId);
// all three inference accounts share ONE logical source slot (append-only siblings).
assert.equal(runA1000.sourceObservationId, runB1000.sourceObservationId);
assert.equal(runB1000.sourceObservationId, runC1002.sourceObservationId);

// --- immutability -----------------------------------------------------------
// Sealed account is frozen; a content change cannot collide onto an existing id.
assert.equal(Object.isFrozen(base), true);
assert.notEqual(base.observationAccountId, valueChange.observationAccountId);

// --- F1: DEEP freeze (nested objects + arrays, not just the top) ------------
const deep = sealObservation(
  content({
    provenance: {
      realityTier: "tier-observed",
      authentication: "AUTHENTICATED",
      channel: "gmail",
      fieldProvenance: [{ field: "amount", realityTier: "tier-observed", channel: "gmail" }],
    },
  })
);
assert.equal(Object.isFrozen(deep), true);
assert.equal(Object.isFrozen(deep.referent), true);
assert.equal(Object.isFrozen(deep.referent.identityBinding), true);
assert.equal(Object.isFrozen(deep.value), true);
assert.equal(Object.isFrozen(deep.provenance), true);
assert.equal(Object.isFrozen(deep.coverage), true);
assert.equal(Object.isFrozen(deep.confidenceBasis), true);
assert.equal(Object.isFrozen(deep.context), true);
assert.equal(Object.isFrozen(deep.context.translatorVersion), true);
// nested array AND its element are frozen
assert.equal(Object.isFrozen(deep.provenance.fieldProvenance), true);
assert.equal(Object.isFrozen(deep.provenance.fieldProvenance![0]), true);
// a nested mutation must NOT take effect. We assert the effect (not a throw):
// under strict mode the write throws, under non-strict it silently no-ops —
// either way a frozen field cannot change, so the record can't drift from its hash.
try {
  (deep.value as unknown as { datum: unknown }).datum = "MUTATED";
} catch {
  /* strict mode throws; non-strict no-ops — both acceptable */
}
assert.equal(deep.value.datum, 1000);

// --- F2: cycle guard → BrainError, never a RangeError ----------------------
const cyc: Record<string, unknown> = { a: 1 };
cyc.self = cyc;
assert.throws(
  () => canonicalize(cyc),
  (err: unknown) =>
    err instanceof BrainError && (err as BrainError).code === "UNSERIALIZABLE"
);
// a shared (acyclic) reference is NOT a cycle and stays deterministic
const shared = { n: 2 };
assert.equal(
  canonicalize({ a: shared, b: shared }),
  canonicalize({ a: { n: 2 }, b: { n: 2 } })
);

// --- identity format --------------------------------------------------------
assert.ok(base.sourceObservationId.startsWith("src_"));
assert.ok(base.observationAccountId.startsWith("acc_"));
assert.ok(base.canonicalHash.startsWith("sha256:"));

// --- GOLDEN VECTOR: C0 observation identity --------------------------------
// Hard-coded expected values, NOT recomputed by the code under test. Any silent
// change to canonical serialization, field inclusion, or an identity formula
// breaks these on purpose. Regenerate ONLY via an explicit, reviewed change.
const GOLDEN_DIGEST = parseSnapshotDigest("regsnap:concept:sha256:" + "0".repeat(64));
const goldenContent: ObservationContent = {
  tenant: { businessId: 1 },
  source: {
    featureDomain: "documents",
    sourceModel: "Document",
    sourceRecordId: "doc-golden",
    emittedObservationIndex: 0,
  },
  concept: { conceptId: conceptId("invoice.amount"), conceptVersion: conceptVersion("1") },
  referent: {
    referentType: "COMMITMENT",
    identityBinding: {
      kind: "RESOLVED",
      entityType: "BillingDocument",
      entityId: 7,
      resolutionMethod: "DETERMINISTIC_EXACT",
    },
  },
  value: { scale: "RATIO", datum: 1234, unit: "ILS" },
  mode: "MEASURE",
  eventTime: { kind: "INSTANT", at: "2026-07-01T00:00:00.000Z" },
  observationTime: { at: "2026-07-02T09:00:00.000Z" },
  provenance: { realityTier: "tier-observed", authentication: "AUTHENTICATED", channel: "gmail" },
  completeness: { kind: "COMPLETE" },
  coverage: {
    state: "FULL",
    sensorState: { sensorId: "gmail", declared: "ACTIVE" },
    absenceInformative: false,
    scopeRef: "doc-golden",
  },
  confidenceBasis: {},
  context: {
    engineEpoch: { epochId: engineEpochId("epoch-1") },
    cotSchemaVersion: cotSchemaVersion("c0-1.2"),
    translatorVersion: {
      translatorName: translatorName("documents-normalize"),
      version: translatorVersionTag("1.0.0"),
    },
    conceptRegistrySnapshot: GOLDEN_DIGEST,
    executionPolicyVersion: executionPolicyVersion("policy-1"),
  },
};
// NOTE: sourceObservationId is UNCHANGED from the pre-Coverage-fix golden
// (src_b9f11aaf…) — proving the source-identity formula is untouched. Only
// canonicalHash + observationAccountId changed, solely because the Coverage
// field content changed shape (T1/T2/T3 tier → FULL/PARTIAL/UNCOVERED grounds).
const EXPECTED_SOURCE_OBSERVATION_ID =
  "src_b9f11aaf0cee99d7399c90f33425189da4c0359a199fa42d0b8f3e3773aa396b";
const EXPECTED_CANONICAL_HASH =
  "sha256:fa0af469296d05f0827fb0802392fb92cf4a21abafded3e397ff84f5ef015159";
const EXPECTED_OBSERVATION_ACCOUNT_ID =
  "acc_d95caf5e63d79ccc55b2abd4ae2deb2a23b95a0ba0ed23b18cdd47397bf77e47";
const goldenSealed = sealObservation(goldenContent);
assert.equal(goldenSealed.sourceObservationId, EXPECTED_SOURCE_OBSERVATION_ID);
assert.equal(goldenSealed.canonicalHash, EXPECTED_CANONICAL_HASH);
assert.equal(goldenSealed.observationAccountId, EXPECTED_OBSERVATION_ACCOUNT_ID);

console.log("C0 observation-identity tests: OK");
