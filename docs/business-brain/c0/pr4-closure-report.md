# C0 PR4 Closure Report — Replay Harness / Execution Modes

```text
Status: Closed
Branch: feat/brain-c0-core-contracts
Commit: 82cd5e9ddcfaf18d3db674c10ea64acbf225b5cf
Closed: 2026-07-14
Worktree: C:/dev/bp-brain-c0 (isolated)
```

A Construction/Governance artifact — the permanent reference for the fourth PR of
the Father Engine. It lives under `docs/` (not `lib/business-brain/`, which is code).

## 1 · Scope

The Replay Harness proves deterministic re-run of Evidence under a pinned dependency
set, and distinguishes the three execution modes. **Fixtures only — no DB, no SoT, no
runtime, no persistence, NO inference invocation, no supersession, no overwrite.** A
Replay Manifest is the FULL identity of a run — successes AND typed rejections AND the
pinned dependencies — not just successful accounts and not just failure categories.

## 2 · Files added / changed

**Added — `lib/business-brain/replay/`:**

- `replay.types.ts` — ExecutionMode, ReplayDependencyContext, ReplayOutcomeSet,
  ReplayManifest, AccountAuditManifest, ReplayRejectionEntry, ReplayComparisonResult,
  ReplayDivergence, ReplayPinningFailureReason, branded digests.
- `registry-pinning.ts` — ReplayDeps, verifyPinning (all 12 reasons).
- `replay-manifest.ts` — auditReplayOutcomes, auditAccountsOnly, compareManifests,
  manifestsEqual, rejectionIdentityDigest, derived counts, canonical ordering.
- `normalization-replay.ts` — produceNormalizationReplay, runHistoricalReplay.
- `timeline.ts` — orderTimeline (deterministic, UNKNOWN partition).
- `replay.verify.test.ts` — DoD + Golden Replay Manifest.

**Changed (additive, golden-safe):**

- `versioning.types.ts` — `NormalizationPolicyVersion`, `TranslatorContractDigest`.
- `normalization/normalize.ts` — `NORMALIZATION_POLICY_VERSION` constant.
- `normalization/translator.interface.ts` — `Translator.contractDigest`.
- `normalization/fixtures/documents-fixture-translator.ts` — declared contract + digest
  + variant + two eventTime scenarios.
- `registry/translator-registry.ts` — `TranslatorDefinition.translatorContractDigest`.
- `registry/registry.verify.test.ts` — fixture translatorContractDigest.
- `package.json` — `verify:brain-replay`.

## 3 · The three Execution Modes

| | HISTORICAL_REPLAY | REPROCESS_NEW_EPOCH | LIVE_NORMALIZE |
|---|---|---|---|
| ExecutionContext | the ORIGINAL pinned one | a NEW epoch | current |
| Translator run | yes (deterministic) | yes | yes |
| OCR/LLM | NEVER (frozen RawInput.inference only) | never | never |
| New accounts | reproduces identity | sibling accounts (new hash) | yes |
| Expected output | manifest EQUAL to the historical one | a NEW manifest, not the historical one | fresh manifest |
| Failure | pinning / manifest divergence | pinning | pinning |

All three run `normalize`; none invokes inference. REPROCESS produces sibling accounts
that share the `sourceObservationId` but carry a new `observationAccountId`.

## 4 · ReplayDependencyContext (full pinning)

```ts
interface ReplayDependencyContext {
  executionContext: ExecutionContext;        // duplicates conceptRegistrySnapshot (verified consistent)
  conceptRegistrySnapshot: RegistrySnapshotDigest;
  coverageRegistrySnapshot: RegistrySnapshotDigest;
  translatorRegistrySnapshot: RegistrySnapshotDigest;
  engineEpochRegistrySnapshot: RegistrySnapshotDigest;
  realityTierVocabularyId: RealityTierVocabularyId;
  realityTierVocabularyDigest: RealityTierVocabularyDigest;
  translatorContractDigest: TranslatorContractDigest;
  normalizationPolicyVersion: NormalizationPolicyVersion;
}
```

Every dependency whose change could alter a normalize run is pinned. It lives in the
REPLAY layer only — never on the COT — so the four prior COT/registry golden literals
are untouched.

## 5 · The 12 Pinning failure reasons

`CONCEPT_SNAPSHOT_MISMATCH` · `COVERAGE_SNAPSHOT_MISMATCH` · `TRANSLATOR_SNAPSHOT_MISMATCH` ·
`ENGINE_EPOCH_SNAPSHOT_MISMATCH` · `ENGINE_EPOCH_MISSING` · `ENGINE_EPOCH_CONCEPT_SNAPSHOT_MISMATCH` ·
`EXECUTION_POLICY_MISMATCH` · `NORMALIZATION_POLICY_MISMATCH` · `TRANSLATOR_NOT_REGISTERED` ·
`TRANSLATOR_VERSION_MISMATCH` · `TRANSLATOR_CONTRACT_MISMATCH` · `REALITY_TIER_VOCABULARY_MISMATCH`.

Each is exercised by a dedicated test. A manifest is NEVER built when pinning fails.

## 6 · ReplayOutcomeSet

```ts
interface ReplayOutcomeSet {
  accounts: readonly CanonicalObservation[];
  rejections: readonly ReplayRejectionEntry[];
}
```

The single shape that both the live path (`produceNormalizationReplay`) and the stored
audit (`auditReplayOutcomes`) build a manifest from — so the round-trip is exact for
successes AND rejections.

## 7 · ReplayManifest vs AccountAuditManifest

- **`ReplayManifest`** — the full run identity: mode + dependencyContext + ordered
  accounts + ordered typed rejections + digest.
- **`AccountAuditManifest`** — a NARROWER type: accounts + accountsDigest only. It never
  represents rejections and is NOT equivalent to a ReplayManifest (`auditAccountsOnly`).

## 8 · Accounts AND typed Rejections in the run identity

The manifest digest covers both. Two runs with the same accounts but different rejection
payloads produce different digests; two runs differing only in input/rejection order
produce the same digest (accounts sorted by `observationAccountId`, rejections sorted
canonically by source + emittedObservationIndex + reason + identityDigest).

## 9 · NormalizationRejectionIdentity + bidirectional exhaustiveness

Each rejection carries a typed, canonical identity (one variant per failure reason;
`CHANNEL_LAUNDERING` carries `fieldPath`, `INVALID_REALITY_TIER` carries `location`,
`CONCEPT_VERSION_AMBIGUOUS` carries sorted+unique `candidateVersions`). Bidirectional
compile-time exhaustiveness guarantees: every failure reason has an identity variant, and
no identity variant names a non-reason. `RejectionIdentityDigest` hashes only the typed
payload — never a free-form string.

## 10 · RealityTierVocabularyId + vocabularyDigest

The injected validator carries both a versioned `vocabularyId` and a content-derived
`vocabularyDigest`. The same id with different content yields a different digest → a
`REALITY_TIER_VOCABULARY_MISMATCH`. Content is not trusted by name alone.

## 11 · translatorContractDigest

Invariant: `TranslatorName + TranslatorVersionTag → immutable meaning and implementation
contract`; a behavioural change requires a new version. `translatorContractDigest` is a
content-derived fingerprint of the DECLARED contract; a drift under the same name+version
→ `TRANSLATOR_CONTRACT_MISMATCH`. It is NOT a hash of runtime code.

## 12 · normalizationPolicyVersion

Pins the normalize() decision ruleset (version selection, value-shape, required-field,
provenance, coverage resolution, failure-reason taxonomy, rejection-identity construction).
Separate from `executionPolicyVersion` (broader/forward-looking). Bump on any rule change.

## 13 · Manifest ordering & Timeline ordering

- **Manifest order** = accounts by `observationAccountId`, rejections by the canonical
  key — the ONLY order in the digest; input-order-independent.
- **Timeline** (a utility, NOT in the digest): known eventTime by start timestamp →
  type rank (INSTANT < INTERVAL) → observationTime → observationAccountId; `UNKNOWN` is a
  SEPARATE partition at the end (temporalBasis `UNKNOWN`), never a silent event-time fallback.

## 14 · Historical Replay vs Expected Manifest

`runHistoricalReplay(rawInputs, deps, expectedManifest)` is a two-step: produce, then
`compareManifests`. The harness never claims divergence without a supplied baseline.

## 15 · REPLAY_MANIFEST_DIVERGENCE structure

```ts
interface ReplayDivergence {
  missingAccounts: readonly ObservationAccountId[];
  unexpectedAccounts: readonly ObservationAccountId[];
  changedBySource: readonly { sourceObservationId; expected?; actual? }[];
  missingRejections: readonly ReplayRejectionEntry[];
  unexpectedRejections: readonly ReplayRejectionEntry[];
}
```

Structured and machine-checkable — never a string.

## 16 · Inference Freeze

The harness contains and imports NO inference function. OCR/LLM output is represented only
as a frozen `RawInput.inference` (engine/version/runId/values already captured). Replay of
the same input is fully deterministic; the same runId reproduces the same account, a new
runId is a new account.

## 17 · Golden Replay Manifest

```text
replaymanifest:sha256:443cf151d72b4a2f32f25e437472aed7b4259fdb0903490438636c7fb1193f1c
```

Hard-coded, non-circular. Pins the dependency context, ordered account identities, and
ordered typed rejection payloads.

## 18 · Known Limits

- **Open interval is not supported yet in `EventTime`.** Open interval support is deferred
  until EventTime is deliberately extended.
- **`translatorContractDigest` locks the DECLARED contract, not a hash of runtime code.**
  A behavioural change requires a new version (a governance invariant).

## 19 · Intentionally NOT in PR4

Detection Grammar · Partition/Window/Sequence runtime · Projection · Phenomena · Beliefs ·
supersession policy · conflict precedence · confidence computation · Prisma/persistence ·
LLM invocation · scheduler/background jobs · production feature translators · source-code /
build-artifact hashing · any change to PR1–PR3 identity contracts.

## 20 · What passes to C1

`readonly CanonicalObservation` accounts + `ReplayManifest` / ExecutionContext + versioned
Type Registries. C1 (Detection Grammar runtime) builds detection ON this substrate; it must
not mutate COTs/Evidence, re-select pinned versions, fabricate coverage, turn Unknown into
negative, re-run inference during replay, bypass typed failures, or use feature vocabulary
instead of Business Concepts.
