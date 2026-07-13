# C0 PR2 Closure Report — Versioned Registries

```text
Status: Closed
Branch: feat/brain-c0-core-contracts
Commit: 866a8c168db7fa86f2ac0cf1fd169a00afcb859f
Closed: 2026-07-13
```

A Construction/Governance artifact — the permanent reference point for the second
PR of the Father Engine. It records what PR2 locked, what it deliberately
excluded, and the decisions that shaped it. It lives under `docs/` (not
`lib/business-brain/`, which is code).

## 1 · Scope

Five versioned Type-Registries + a shared snapshot machine + a single home for
branded identity types. **Types only — no Instances, no Tenant data, no runtime,
no persistence.** Plus an additive, byte-transparent re-typing of PR1 fields from
`string` to branded identities, and two hard-coded Golden Hash Vectors.

## 2 · Files added / changed

**Added (new):**

- `lib/business-brain/versioning.types.ts` — branded identities + validating constructors
- `lib/business-brain/registry/registry-snapshot.ts` — buildSnapshot / digest / parseSnapshotDigest
- `lib/business-brain/registry/concept-registry.ts`
- `lib/business-brain/registry/referent-taxonomy.ts`
- `lib/business-brain/registry/coverage-registry.ts`
- `lib/business-brain/registry/translator-registry.ts`
- `lib/business-brain/registry/engine-epoch-registry.ts`
- `lib/business-brain/registry/seed/concepts.seed.ts` — test fixtures
- `lib/business-brain/registry/registry.verify.test.ts` — DoD + Golden Vector

**Changed (additive):**

- `lib/business-brain/observation.types.ts` — `string` → branded on 9 fields (byte-transparent)
- `lib/business-brain/brain-error.ts` — +3 codes (INVALID_VERSIONING_ID, REGISTRY_DUPLICATE_ENTRY, REGISTRY_IMMUTABLE_VIOLATION)
- `lib/business-brain/observation-identity.verify.test.ts` — fixtures → constructors, real digest, Golden Vector
- `package.json` — `verify:brain-registries`

## 3 · Contracts locked (Source of Truth in code)

- **Branded identities** live in ONE place (`versioning.types.ts`); no parallel mirrors.
- **Constructors are the only mint** for developer/fixture identities, and they VALIDATE
  (reject empty / whitespace-only / surrounding-whitespace → `INVALID_VERSIONING_ID`).
  They are byte-preserving on clean input.
- **`RegistrySnapshotDigest` is minted ONLY** by `buildSnapshot()` (or validated by
  `parseSnapshotDigest()`); it can never be a free-form string, so an invented digest
  cannot attach to an ExecutionContext.
- **Registry immutability** is enforced at build over FULL canonical content:
  same key + identical content → `REGISTRY_DUPLICATE_ENTRY`; same key + different content
  → `REGISTRY_IMMUTABLE_VIOLATION`.
- **Typed lookup results** everywhere — never a silent `undefined`, never a throw on lookup.
- **conceptId is clean of the aspect** — the aspect lives only in `aspect`.

## 4 · Invariants proven

1. **Deterministic snapshot digest** — same entries in any order → the same digest
   (insertion-order-independent).
2. **Schema-versioned digest** — `registryKind` + `snapshotSchemaVersion` + sorted entries
   all participate; a future shape change cannot masquerade as the same digest.
3. **Deep-frozen** — registry, snapshot, entries array, and each entry are frozen.
4. **No tenant data** — recursive key scan of the registries finds no
   `businessId`/`tenant`/`tenantId`/`userId`.
5. **Exact-match referent resolution** — no subsumption; adding a subtype does not change
   how a parent resolves.
6. **Coverage never infers `absenceInformative`** — it is a stored explicit policy, never
   derived from `coverageState`.
7. **Byte-transparent re-typing** — for the same runtime value, `string` → branded changes
   no serialization/hash byte (proven by a branded-vs-plain canonicalize equality test).
8. **Golden Vectors** — hard-coded expected values (not recomputed by the code under test)
   lock the C0 identity formulas and the concept snapshot digest against silent drift.

## 5 · The five Registries and their roles

- **Business Concept Registry** — canonical versioned catalog of World Concepts.
  Identity = `(conceptId, conceptVersion)`; `effectiveFrom`/`effectiveTo`; typed resolve +
  read-only `listVersions` (time-based selection is PR3).
- **Referent Taxonomy** — fixed parents (PARTY/COMMITMENT/RESOURCE) + additive subtypes;
  exact-match only, no subsumption.
- **Coverage Registry** — key = referent(type+subtype) × concept × source sensor;
  `FULL|PARTIAL|UNCOVERED` + `SensorState` (static, no liveness) + explicit
  `absenceInformative`. Missing key → explicit `NO_ENTRY`.
- **Translator Registry** — stable `TranslatorName` + explicit `TranslatorVersionTag`;
  definition catalog only (no live translator, no SoT reading).
- **Engine Epoch Registry** — pins a `conceptRegistrySnapshot` digest + an
  `executionPolicyVersion` (Policy itself is PR4); deterministic lookup by `epochId`.

## 6 · Registry Snapshot contract + Golden Digest

```text
digest = "regsnap:" + kind + ":sha256:" +
         sha256Hex(canonicalize({ registryKind, snapshotSchemaVersion, entries(sorted) }))
```

- Entries are canonically sorted by key → insertion-order-independent.
- Deep-frozen; reuses PR1 primitives only (`canonicalize`, `sha256Hex`, `deepFreeze`).
- **Golden Vector (locked):**
  `regsnap:concept:sha256:57611431a8994e7018e293edae4f0531f8c41fb1b47948372fcde5cb336824aa`
  Regenerate only through an explicit, reviewed change.

## 7 · Shared branded identities added

`ConceptId` · `ConceptVersion` · `TranslatorName` · `TranslatorVersionTag` ·
`EngineEpochId` · `CotSchemaVersion` · `ExecutionPolicyVersion` · `ReferentSubtype` ·
`RegistrySnapshotDigest` · `RegistrySnapshotSchemaVersion`.

Reconciliation with PR1: `EngineEpoch` and `TranslatorVersion` remain PR1 value objects
(NOT flattened to ids). Three distinct shapes are kept distinct: `EngineEpochId` (identity)
vs `EngineEpoch` (COT reference) vs `EngineEpochDefinition` (registry record).

## 8 · The three seed concepts (Fixtures only)

| conceptId | version | referentType | aspect | valueShape |
|---|---|---|---|---|
| `SalesCommitment` | 1 | COMMITMENT | Established | EVENT / NOMINAL |
| `Communication` | 1 | PARTY | Received | EVENT / NOMINAL |
| `ResourceLevel` | 1 | RESOURCE | Observed | MEASURE / RATIO (count) |

Marked in code as **test fixtures — NOT a production catalog and NOT a ratified semantic
source of truth.** Each conceptId is clean of the aspect.

## 9 · Intentionally NOT in PR2

Normalize · Fixture-Translator execution · Source-of-Truth reading · Prisma/migration ·
ConfidencePolicy computation · Detection Grammar · Runtime · Replay orchestration ·
Beliefs · Judgment · DB-backed registry · subsumption semantics · version selection by
time · RealityTier precedence/vocabulary · any change to PR1 identity contracts.

## 10 · Deferred Items

- **Aspect ↔ Referent Type semantic validation** — no matrix invented; awaits an approved
  source of truth (Normalize / Concept semantic validation).
- **RealityTier vocabulary / precedence** — still an opaque token; canonical registry TBD.
- **Time-based concept version selection** — PR3 (Normalize).
- **Normalize** — PR3.
- **Replay executor** — PR4.

## 11 · Findings during PR2

- **F-1 (disclosure, not a regression)** — the PR1 fixture placeholder `snap-a` was replaced
  by a valid digest, because `conceptRegistrySnapshot` is now a format-validated
  `RegistrySnapshotDigest`. Precise statement: *for the same runtime value, string → branded
  changes no serialization/hash; one fixture received a new, deliberate runtime value, so its
  hash changed lawfully.* Identity-algorithm hashing is unchanged.
- **F-2 (deferred, correct)** — the registry does not validate `aspect` ↔ `referentType`
  compatibility; deferred until an approved source of truth exists.
- **Golden Hash Vectors added** — hard-coded, non-circular expected values for the C0
  observation identity and the concept snapshot digest, to make any silent change to the
  canonical representation fail explicitly.

## 12 · Construction Status

| Stage | Status |
|---|---|
| PR1 — Core Contracts | ✅ Complete |
| PR2 — Versioned Registries | ✅ Complete |
| PR3 — Normalize | Pending |
| PR4 — Replay Harness | Pending |
