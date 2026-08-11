# C0 PR3 Closure Report — Fixture Translator + Normalize + Coverage Correction

```text
Status: Closed
Branch: feat/brain-c0-core-contracts
Commit: 7c92025edcd6370b81ec1a6ee11c795218bc8aa0
Closed: 2026-07-13
```

A Construction/Governance artifact — the permanent reference for the third PR of
the Father Engine. It lives under `docs/` (not `lib/business-brain/`, which is code).

## 1 · Scope

The full Normalize pipeline over fixtures, plus an owner-approved correction of the
PR1 Coverage contract. **Fixtures only — no DB, no Source of Truth, no runtime, no
replay, no persistence.** normalize() is a pure orchestrator that returns EITHER a
sealed CanonicalObservation OR a typed rejection — it never fabricates a COT.

## 2 · Files added / changed

**Added:**

- `lib/business-brain/coverage.types.ts` — shared Coverage grounds (COT + registry)
- `lib/business-brain/normalization/normalization-result.types.ts`
- `lib/business-brain/normalization/translator.interface.ts`
- `lib/business-brain/normalization/reality-tier-registry.ts`
- `lib/business-brain/normalization/value-shape-validation.ts`
- `lib/business-brain/normalization/provenance-validation.ts`
- `lib/business-brain/normalization/normalize.ts`
- `lib/business-brain/normalization/fixtures/documents-fixture-translator.ts`
- `lib/business-brain/normalization/normalization.verify.test.ts`

**Changed (Coverage correction):**

- `lib/business-brain/observation.types.ts` — Coverage now imported from coverage.types; CoverageTier removed from the COT
- `lib/business-brain/registry/coverage-registry.ts` — consumes the shared types (no mirror)
- `lib/business-brain/observation-identity.verify.test.ts` — Coverage fixtures + regenerated golden literals
- `package.json` — `verify:brain-normalize`

## 3 · The Normalize pipeline (as built)

```
Raw Fixture
→ Translator (emits Business Concept projections)
→ Snapshot pinning check
→ Concept version resolution (by observationTime)
→ ValueShape validation
→ Required-field check
→ Provenance validation (reality tiers + structural anti-laundering)
→ Coverage resolution (explicit entry required)
→ assemble ObservationContent → sealObservation()
→ CanonicalObservation Account   OR   typed NormalizationResult failure
```

## 4 · Translator contract

- Emits a **Business Concept** (`conceptId`), never feature vocabulary.
- Assigns `emittedObservationIndex` (fan-out discriminator).
- Carries OCR/LLM `runId` via `provenanceDraft.inference`.
- `causeRef` is an **originating-action CORRELATION reference, NOT a causal claim**.
- Proposes `conceptId` (+ `requestedConceptVersion` only for a version-pinned source);
  normalize OWNS effective-version selection.
- Reads fixtures only — no DB, no SoT.

## 5 · Concept version selection contract

- Selection time = **`observationTime`** (never `now`, never `eventTime`), against the
  PINNED snapshot.
- Normal path: the UNIQUE version whose `effectiveFrom ≤ observationTime < (effectiveTo ?? ∞)`.
- Explicit `requestedConceptVersion`: validated (exists AND effective) — **no silent fallback**.
- Concept-existence is checked before version (`UNKNOWN_CONCEPT` before `UNKNOWN_CONCEPT_VERSION`).
- Late-arriving event: old `eventTime` preserved; version chosen under `observationTime`.
- Historical Replay does NOT re-select — that is PR4.

## 6 · Injected RealityTier Validator contract

- normalize depends on the `RealityTierValidator` INTERFACE, not a fixed list.
- A TEST-ONLY fixture allow-list is provided; the real (off-main) vocabulary is injected later.
- No token is valid merely for being a string. There is NO ranking / precedence / ceiling.

## 7 · Corrected Coverage contract

```ts
// lib/business-brain/coverage.types.ts (shared by COT + registry)
type CoverageState = "FULL" | "PARTIAL" | "UNCOVERED";
type SensorDeclaredState = "ACTIVE" | "INACTIVE" | "UNKNOWN";
interface SensorState { sensorId: string; declared: SensorDeclaredState; }
interface Coverage {
  state: CoverageState;
  sensorState: SensorState;       // declared (snapshot), never live
  absenceInformative: boolean;    // explicit policy, never inferred
  scopeRef: string;
}
```

T1/T2/T3 is a DIFFERENT axis (Observability Ontology detectability), derived later —
removed from the COT. `sensorState` and `absenceInformative` are carried VERBATIM from
the coverage entry; normalize invents no defaults.

## 8 · Explicit UNCOVERED vs missing entry (load-bearing distinction)

- **Explicit `UNCOVERED` entry** → a valid COT with honest coverage grounds.
- **Missing coverage entry (`NO_ENTRY`)** → a typed rejection `COVERAGE_ENTRY_MISSING`,
  NO COT. A missing declaration is not a decision that the domain is uncovered
  (`missing != negative`); fabricating `UNCOVERED` would hide a configuration gap.

## 9 · IdentityBinding (as committed, unchanged by PR3)

```ts
type IdentityBinding =
  | { kind: "RESOLVED"; entityType: string; entityId: number; resolutionMethod: ResolutionMethod }
  | { kind: "SIGNAL_ONLY"; signalType: string; signalValue: string }
  | { kind: "UNRESOLVED"; reason: UnknownReason };
```

Free-text identity → `SIGNAL_ONLY { signalType: "free-text", signalValue }`. No new
`FREE_TEXT` / `ANCHOR` kinds. `SELF_ANCHOR` remains a `ResolutionMethod` of `RESOLVED`.

## 10 · Failure reasons locked

```ts
type NormalizationFailureReason =
  | "SNAPSHOT_MISMATCH"
  | "UNKNOWN_CONCEPT"
  | "UNKNOWN_CONCEPT_VERSION"
  | "NO_EFFECTIVE_CONCEPT_VERSION"
  | "REQUESTED_CONCEPT_VERSION_NOT_EFFECTIVE"
  | "CONCEPT_VERSION_AMBIGUOUS"
  | "VALUE_SHAPE_MISMATCH"
  | "MISSING_REQUIRED_FIELD"
  | "COVERAGE_ENTRY_MISSING"
  | "INVALID_REALITY_TIER"
  | "CHANNEL_LAUNDERING";
```

No generic `INVALID_INPUT`.

## 11 · Invariants proven

1. Pure orchestration — no DB / SoT / wall-clock / replay.
2. Version selection by `observationTime` against the pinned snapshot; deterministic.
3. Unknown is a typed rejection, never a fabricated COT.
4. `NO_ENTRY` coverage → rejection; only explicit `UNCOVERED` → valid COT.
5. `sensorState` + `absenceInformative` carried verbatim (no inference, no defaults).
6. Field provenance preserved verbatim; record-level provenance never upgrades it.
7. Account = the inference act (distinct `runId` → distinct account; same run → dedup).
8. Late-arriving: old `eventTime` + new `observationTime`.
9. Fan-out → distinct source slots sharing a correlation `causeRef`.
10. Cross-tenant isolation (tenant in the source anchor); registries tenant-free.
11. No T1/T2/T3 mapping anywhere in the COT or Normalize.

## 12 · Golden Values changed by the Coverage fix

| | old | new |
|---|---|---|
| `sourceObservationId` | `src_b9f11aaf…396b` | `src_b9f11aaf…396b` (UNCHANGED) |
| `canonicalHash` | `sha256:6b437134…1e5c` | `sha256:fa0af469…5159` |
| `observationAccountId` | `acc_5a53a796…439b` | `acc_d95caf5e…7e47` |

**Reason:** the COT `coverage` field changed shape (T1/T2/T3 tier → FULL/PARTIAL/UNCOVERED
grounds), changing the canonical content. `sourceObservationId` is unchanged because it is
derived from the source anchor only (coverage is not part of it) — proving the
source-identity / canonicalHash / accountId formulas and the serialization + digest
algorithms are untouched (those files were not modified).

## 13 · Intentionally NOT in PR3

Replay orchestration · Projection (detectors) · Detection Grammar · Confidence computation ·
semantic matrices (referent↔concept, aspect↔referent) · DB persistence.

## 14 · Deferred Items

- Eager validation of overlapping effective ranges (currently lazy →
  `CONCEPT_VERSION_AMBIGUOUS` at normalize).
- Referent ↔ Concept semantics.
- Aspect ↔ Referent semantics.
- RealityTier canonical vocabulary / precedence.

## 15 · Construction Status

| Stage | Status |
|---|---|
| PR1 — Core Contracts | ✅ Complete |
| PR2 — Versioned Registries | ✅ Complete |
| PR3 — Normalize | ✅ Complete |
| PR4 — Replay Harness | Pending |
