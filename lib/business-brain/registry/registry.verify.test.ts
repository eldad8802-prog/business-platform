/**
 * C0 / PR2 — Versioned Registries verification.
 * Run with:  npx tsx lib/business-brain/registry/registry.verify.test.ts
 * (or: npm run verify:brain-registries)
 *
 * Pure logic only — no database, no UI, no HTTP, no tenant data. Proves the PR2
 * DoD: versioned identity, immutability, deterministic frozen snapshots, typed
 * lookups, no silent undefined, and byte-identical hashing after PR1 re-typing.
 */
import assert from "node:assert/strict";
import { BrainError } from "../brain-error";
import { canonicalize } from "../canonical-serialize";
import {
  conceptId,
  conceptVersion,
  engineEpochId,
  executionPolicyVersion,
  referentSubtype,
  translatorName,
  translatorVersionTag,
  type TranslatorContractDigest,
} from "../versioning.types";
import { parseSnapshotDigest } from "./registry-snapshot";
import {
  buildConceptRegistry,
  type BusinessConceptDefinition,
} from "./concept-registry";
import { buildReferentTaxonomy } from "./referent-taxonomy";
import { buildCoverageRegistry, type CoverageEntry } from "./coverage-registry";
import { buildTranslatorRegistry } from "./translator-registry";
import { buildEngineEpochRegistry } from "./engine-epoch-registry";
import { SEED_CONCEPTS } from "./seed/concepts.seed";

// --- fixtures --------------------------------------------------------------

function concept(
  id: string,
  version: string,
  semantic = "def"
): BusinessConceptDefinition {
  return {
    conceptId: conceptId(id),
    conceptVersion: conceptVersion(version),
    referentType: "COMMITMENT",
    aspect: "Established",
    valueShape: { mode: "EVENT", scale: "NOMINAL" },
    semanticDefinition: semantic,
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  };
}

// --- 1. adding a new version is allowed ------------------------------------

const twoVersions = buildConceptRegistry([concept("X", "1"), concept("X", "2")]);
assert.equal(twoVersions.resolve(conceptId("X"), conceptVersion("1")).status, "FOUND");
assert.equal(twoVersions.resolve(conceptId("X"), conceptVersion("2")).status, "FOUND");
assert.equal(twoVersions.listVersions(conceptId("X")).length, 2);

// --- 2. overwriting (id,version) is rejected -------------------------------

// identical duplicate → DUPLICATE
assert.throws(
  () => buildConceptRegistry([concept("X", "1"), concept("X", "1")]),
  (e: unknown) => e instanceof BrainError && e.code === "REGISTRY_DUPLICATE_ENTRY"
);

// --- 3. changing semanticDefinition under same version is rejected ---------

assert.throws(
  () => buildConceptRegistry([concept("X", "1", "old"), concept("X", "1", "new")]),
  (e: unknown) => e instanceof BrainError && e.code === "REGISTRY_IMMUTABLE_VIOLATION"
);

// --- 4. lookup by snapshot returns only entries in THAT snapshot ------------

const regA = buildConceptRegistry([concept("A", "1")]);
const regB = buildConceptRegistry([concept("B", "1")]);
assert.equal(regA.resolve(conceptId("A"), conceptVersion("1")).status, "FOUND");
assert.equal(regB.resolve(conceptId("A"), conceptVersion("1")).status, "UNKNOWN_CONCEPT");

// --- 5. unknown concept/version → typed result, never undefined/throw -------

const seed = buildConceptRegistry(SEED_CONCEPTS);
const unknownConcept = seed.resolve(conceptId("Nope"), conceptVersion("1"));
assert.equal(unknownConcept.status, "UNKNOWN_CONCEPT");
const unknownVersion = seed.resolve(conceptId("SalesCommitment"), conceptVersion("9"));
assert.equal(unknownVersion.status, "UNKNOWN_VERSION");
const found = seed.resolve(conceptId("SalesCommitment"), conceptVersion("1"));
assert.equal(found.status, "FOUND");

// --- 6. digest deterministic + insertion-order-independent -----------------

const forward = buildConceptRegistry(SEED_CONCEPTS);
const reversed = buildConceptRegistry([...SEED_CONCEPTS].reverse());
assert.equal(forward.snapshot.digest, reversed.snapshot.digest);
// digest format is valid + round-trips through the parser
assert.equal(parseSnapshotDigest(forward.snapshot.digest), forward.snapshot.digest);
assert.ok(/^regsnap:concept:sha256:[0-9a-f]{64}$/.test(forward.snapshot.digest));
// a different entry set → a different digest
assert.notEqual(forward.snapshot.digest, regA.snapshot.digest);

// --- 7. registry + snapshot are frozen (no external mutation) --------------

assert.equal(Object.isFrozen(seed), true);
assert.equal(Object.isFrozen(seed.snapshot), true);
assert.equal(Object.isFrozen(seed.snapshot.entries), true);
assert.equal(Object.isFrozen(seed.snapshot.entries[0]), true);

// --- 8. NO tenant data in Type registries ----------------------------------

function collectKeys(value: unknown, acc: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const el of value) collectKeys(el, acc);
    return;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    acc.add(k);
    collectKeys((value as Record<string, unknown>)[k], acc);
  }
}
const seedKeys = new Set<string>();
collectKeys(SEED_CONCEPTS, seedKeys);
for (const forbidden of ["businessId", "tenant", "tenantId", "userId"]) {
  assert.equal(seedKeys.has(forbidden), false);
}

// --- 9. adding a referent subtype does NOT change parent resolution --------

const taxNoSub = buildReferentTaxonomy([]);
const taxWithSub = buildReferentTaxonomy([
  {
    referentType: "PARTY",
    subtype: referentSubtype("Supplier"),
    semanticDefinition: "A supplier party",
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
]);
assert.deepEqual(taxNoSub.resolve("PARTY"), taxWithSub.resolve("PARTY"));
// exact-match, no subsumption: an unknown subtype is UNKNOWN_SUBTYPE, not inferred
assert.equal(taxWithSub.resolve("PARTY", referentSubtype("Ghost")).status, "UNKNOWN_SUBTYPE");
assert.equal(taxWithSub.resolve("PARTY", referentSubtype("Supplier")).status, "FOUND");
assert.equal(taxWithSub.resolve("NotAType").status, "UNKNOWN_TYPE");

// --- 10. Coverage does NOT infer absenceInformative from coverageState ------

const cov: CoverageEntry[] = [
  {
    referentType: "RESOURCE",
    conceptId: conceptId("ResourceLevel"),
    sourceSensor: "inventory",
    coverageState: "FULL",
    sensorState: { sensorId: "inv-1", declared: "ACTIVE" },
    absenceInformative: true,
  },
  {
    referentType: "PARTY",
    conceptId: conceptId("Communication"),
    sourceSensor: "gmail",
    coverageState: "FULL", // same state ...
    sensorState: { sensorId: "gm-1", declared: "ACTIVE" },
    absenceInformative: false, // ... different explicit policy
  },
];
const coverage = buildCoverageRegistry(cov);
const r1 = coverage.resolve({
  referentType: "RESOURCE",
  conceptId: conceptId("ResourceLevel"),
  sourceSensor: "inventory",
});
const r2 = coverage.resolve({
  referentType: "PARTY",
  conceptId: conceptId("Communication"),
  sourceSensor: "gmail",
});
assert.equal(r1.status === "FOUND" && r1.entry.absenceInformative, true);
assert.equal(r2.status === "FOUND" && r2.entry.absenceInformative, false);
// a missing key → explicit NO_ENTRY, never a silent "covered"
assert.equal(
  coverage.resolve({
    referentType: "RESOURCE",
    conceptId: conceptId("Nope"),
    sourceSensor: "x",
  }).status,
  "NO_ENTRY"
);

// --- 11. Translator + Engine Epoch typed lookups ----------------------------

const translators = buildTranslatorRegistry([
  {
    translatorName: translatorName("documents-normalize"),
    version: translatorVersionTag("1.0.0"),
    translatorContractDigest: ("translatorcontract:sha256:" +
      "0".repeat(64)) as TranslatorContractDigest,
    semanticDefinition: "maps documents to COT",
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
]);
assert.equal(
  translators.resolve(translatorName("documents-normalize"), translatorVersionTag("1.0.0")).status,
  "FOUND"
);
assert.equal(
  translators.resolve(translatorName("documents-normalize"), translatorVersionTag("9.9.9")).status,
  "UNKNOWN_VERSION"
);
assert.equal(
  translators.resolve(translatorName("ghost"), translatorVersionTag("1.0.0")).status,
  "UNKNOWN_TRANSLATOR"
);

// engine epoch pins a real concept-snapshot digest
const epochs = buildEngineEpochRegistry([
  {
    epochId: engineEpochId("brain-engine@1"),
    conceptRegistrySnapshot: seed.snapshot.digest,
    executionPolicyVersion: executionPolicyVersion("policy-1"),
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
]);
const epoch = epochs.resolve(engineEpochId("brain-engine@1"));
assert.equal(epoch.status, "FOUND");
assert.equal(
  epoch.status === "FOUND" && epoch.definition.conceptRegistrySnapshot,
  seed.snapshot.digest
);
assert.equal(epochs.resolve(engineEpochId("ghost")).status, "UNKNOWN_EPOCH");

// --- 12. constructors validate (INVALID_VERSIONING_ID) ----------------------

for (const bad of ["", "   ", " x", "x "]) {
  assert.throws(
    () => conceptId(bad),
    (e: unknown) => e instanceof BrainError && e.code === "INVALID_VERSIONING_ID"
  );
}
// an invented / malformed digest cannot be parsed into a RegistrySnapshotDigest
assert.throws(
  () => parseSnapshotDigest("snap-a"),
  (e: unknown) => e instanceof BrainError && e.code === "INVALID_VERSIONING_ID"
);

// --- 13. byte-identity: PR1 re-typing (string→brand) changes no hash bytes --
// A branded-built object and an identically-valued plain object canonicalize to
// the exact same bytes — proving the re-typing is hash-transparent.
const brandedCtx = {
  engineEpoch: { epochId: engineEpochId("epoch-1") },
  cotSchemaVersion: "c0-1.2",
  translatorVersion: {
    translatorName: translatorName("documents-normalize"),
    version: translatorVersionTag("1.0.0"),
  },
  conceptRegistrySnapshot: seed.snapshot.digest,
  executionPolicyVersion: executionPolicyVersion("policy-1"),
};
const plainCtx = {
  engineEpoch: { epochId: "epoch-1" },
  cotSchemaVersion: "c0-1.2",
  translatorVersion: { translatorName: "documents-normalize", version: "1.0.0" },
  conceptRegistrySnapshot: String(seed.snapshot.digest),
  executionPolicyVersion: "policy-1",
};
assert.equal(canonicalize(brandedCtx), canonicalize(plainCtx));
// constructors are byte-preserving on clean input
assert.equal(conceptId("invoice.amount"), "invoice.amount");
assert.equal(translatorVersionTag("1.0.0"), "1.0.0");

// --- 14. GOLDEN VECTOR: concept snapshot digest ----------------------------
// Hard-coded expected digest, NOT recomputed by buildSnapshot/canonicalize/
// sha256Hex in this test. It locks the participation of registryKind,
// snapshotSchemaVersion, entry content, AND canonical order. If any of those
// silently changes (including the schema version), this breaks on purpose and
// must be regenerated via an explicit, reviewed change.
const EXPECTED_CONCEPT_SNAPSHOT_DIGEST =
  "regsnap:concept:sha256:57611431a8994e7018e293edae4f0531f8c41fb1b47948372fcde5cb336824aa";
assert.equal(buildConceptRegistry(SEED_CONCEPTS).snapshot.digest, EXPECTED_CONCEPT_SNAPSHOT_DIGEST);

// stability: reversed entry order → same golden digest
assert.equal(
  buildConceptRegistry([...SEED_CONCEPTS].reverse()).snapshot.digest,
  EXPECTED_CONCEPT_SNAPSHOT_DIGEST
);

// stability: same content in fresh objects with SHUFFLED key order → same digest
const shuffledKeys = SEED_CONCEPTS.map((e) => ({
  effectiveFrom: e.effectiveFrom,
  semanticDefinition: e.semanticDefinition,
  valueShape: { scale: e.valueShape.scale, mode: e.valueShape.mode, unitDimension: e.valueShape.unitDimension },
  aspect: e.aspect,
  referentType: e.referentType,
  conceptVersion: e.conceptVersion,
  conceptId: e.conceptId,
  effectiveTo: e.effectiveTo,
}));
assert.equal(
  buildConceptRegistry(shuffledKeys).snapshot.digest,
  EXPECTED_CONCEPT_SNAPSHOT_DIGEST
);

console.log("C0 registry (PR2) tests: OK");
