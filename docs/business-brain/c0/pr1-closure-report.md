# C0 PR1 Closure Report — Canonical Observation Core Contracts

```text
Status: Closed
Branch: feat/brain-c0-core-contracts
Commit: 50be8c0569aa53a75bd7a84aaca25bcd26181aa0
Closed: 2026-07-12
```

This document is a Construction/Governance artifact — a permanent reference point
for the first PR of the Father Engine (מנוע האב). It records what PR1 locked, what
it deliberately excluded, and why key decisions changed mid-flight. It intentionally
lives under `docs/` (not `lib/business-brain/`, which is code).

## 1 · Scope

7 files, +742 lines, under `lib/business-brain/` (+ one `verify:brain-c0` line in
`package.json`). The pure foundation layer of the Father Engine: **COT types ·
identity · deterministic serialization · hashing · immutability · domain error**.
No DB, no HTTP, no feature imports.

Files:

- `lib/business-brain/brain-error.ts`
- `lib/business-brain/canonical-serialize.ts`
- `lib/business-brain/deep-freeze.ts`
- `lib/business-brain/observation.types.ts`
- `lib/business-brain/observation-identity.ts`
- `lib/business-brain/observation-identity.verify.test.ts`

## 2 · Contracts locked (Source of Truth in code from now on)

| Contract | File |
|---|---|
| Three-identifier model: `sourceObservationId` (Logical Source) · `canonicalHash` (content, branded) · `observationAccountId` (Immutable Account) | observation.types.ts |
| `sourceObservationId = hash(source-anchor ONLY + stable translatorName)` | observation-identity.ts |
| `canonicalHash = hash(full content + context, excluding the 3 identity fields)` | observation-identity.ts |
| `observationAccountId = hash(sourceObservationId + canonicalHash)` | observation-identity.ts |
| Canonical serialization: recursive key-sort · undefined-strip · Date→ISO(UTC) · non-finite→reject · array-order = content · cycle→BrainError | canonical-serialize.ts |
| `ObservationContent = Omit<CanonicalObservation, 3 ids>` (hash cannot include itself) | observation.types.ts |
| `ConfidenceBasis` = grounds only (no ceiling / no computed values) | observation.types.ts |
| `ExecutionContext` pinned {engineEpoch, cotSchemaVersion, translatorVersion, conceptRegistrySnapshot, executionPolicyVersion} | observation.types.ts |
| `BrainError` (domain error, separate from HTTP AppError) | brain-error.ts |

**Note:** `sourceObservationId`, `canonicalHash`, and `observationAccountId` are
**three distinct identities**, never interchangeable — a Logical Source slot, a
content fingerprint, and an Immutable Account, respectively.

## 3 · Invariants proven today

1. **Immutability** — a sealed COT is deep-frozen (nested objects + arrays); a nested
   mutation cannot take effect → the record can never drift from its `canonicalHash`.
2. **Determinism** — same content, any key order, any machine → identical
   `canonicalHash` and ids.
3. **Source ⟂ Content** — `sourceObservationId` is stable across content / context /
   epoch / translator-version changes; `canonicalHash` changes on any content/context change.
4. **Account = the act** — a distinct `runId` → a distinct account, even with an
   identical output; same `runId` + content → dedup.
5. **Retry idempotency** — identical content re-sealed → identical ids (no duplicate account).
6. **Fan-out** — distinct `emittedObservationIndex` → distinct source + account.
7. **Append-only siblings** — one Logical Source → many accounts; **there is no
   `supersession` in the C0 layer**.
8. **No self-reference / no circular deps** — `canonicalHash` does not include itself;
   the import graph is linear.
9. **Total failure typing** — every canonicalization failure → `BrainError` (never a raw
   `RangeError` / silent `NaN`).
10. **Nominal safety** — the three identifiers are branded; they cannot be mixed or
    swapped at compile time.

## 4 · Intentionally NOT in PR1 (PR1 boundaries)

Registry · Normalize · Translators · Runtime · Projection · Detection Grammar ·
ConfidencePolicy (computed confidence / ceiling) · persistence/Prisma · enforcement
of the `RealityTier` vocabulary. None of these are implemented in PR1 — PR1 is
**atom contracts only**.

## 5 · Known Deferred Items (PR2–PR4)

- **PR2** — canonical-serialize hardening + expanded identity/edge tests.
- **PR3** — fixture Translator + Normalize + `NormalizationResult`; **start of
  `RealityTier` boundary validation** (the forward obligation from the RealityTier note).
- **PR4** — Concept Registry + snapshot-pinning + (id,version) validation against a
  locked snapshot; `ConfidencePolicy` (computed confidence, ceiling); execution of the
  three Replay modes; `ExecutionContext` wiring.
- **Cross-cutting** — `temporalBasis` at the Projection layer (D7); persistence schema;
  canonical Registry for `RealityTier` (its source of truth is off-main).

## 6 · Replay Guarantees

**Already guaranteed:** given identical `ObservationContent` + `ExecutionContext`,
sealing reproduces **full atom identity** — the same `sourceObservationId`,
`canonicalHash`, and `observationAccountId`, deterministically and machine-independently.

**Not yet guaranteed:** there is no run-level replay orchestration — no storage, no
executor for `HISTORICAL_REPLAY` vs `REPROCESS_NEW_EPOCH`, no multiset/ordering guarantee
across a whole run, and no frozen inference outputs. These depend on Registry + Runtime (PR4).

## 7 · Construction Status

| Stage | Status |
|---|---|
| PR1 — Core Contracts | ✅ Complete |
| PR2 — Serialization hardening + identity tests | Pending |
| PR3 — Fixture Translator + Normalize | Pending |
| PR4 — Registry + ConfidencePolicy + Replay modes | Pending |

## 8 · Lessons Learned (decisions that changed during PR1)

- **ObservationId split** (single id → `sourceObservationId` + `observationAccountId`) —
  to preserve Immutability + Append-only: one observation cannot have two contents.
- **Removal of Supersession** — C0 does not decide which account wins; that is a
  Belief / Execution-Policy decision. C0 only *appends* a sibling.
- **Account = observation/inference act** (not the semantic value) — `runId` lives inside
  the content; two runs with an identical output are two accounts, faithful to Evidence.
- **Grounds vs Computed confidence** — computed values were removed from `ConfidenceBasis`
  so a future policy change never reinterprets historical COTs.
- **Pinned ExecutionContext** — concept-version selected by observationTime and frozen;
  Replay uses the pinned snapshot, not the current clock.
- **D7 — no silent temporal fallback** — `eventTime=UNKNOWN` does not silently fall back
  to observationTime.
- **F1/F2/F3 (found in review before commit)** — deep-freeze instead of shallow freeze ·
  cycle-guard → BrainError instead of RangeError · branded `CanonicalHash`. All three were
  local implementation bugs, zero architecture reopening.

## RealityTier — explicit deferral

`RealityTier` remains **deferred and NOT canonically defined in PR1**. It is an opaque
`string` token; its 8-tier vocabulary is owned by the (off-main) Evidence & Reality
Constitution. No PR1 component derives order or precedence from a `RealityTier` string.
A future PR wires a canonical Registry; until then, any received `RealityTier` must be
validated at the Normalization/Registry boundary (PR3/PR4) and is never valid merely
because it is a string.
