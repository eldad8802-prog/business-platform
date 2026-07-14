# C0 — Final Construction Report

```text
Status: Construction Complete (PR1–PR4)
Branch: feat/brain-c0-core-contracts
Head at close: bbe4d20 (docs) over 82cd5e9 (PR4 code)
Worktree: C:/dev/bp-brain-c0 (isolated)
Closed: 2026-07-14
```

This is the official closure document for the whole of C0 (the Canonical Observation
substrate of the Father Engine). It is SELF-CONTAINED — it does not assume the reader
opens the four per-PR closure reports.

## 1 · Purpose of C0

C0 guarantees, on fixtures only, without any DB/LLM/runtime:

- A **canonical language for observations** (the COT: concept, referent, value, times,
  provenance, completeness, coverage, confidence grounds, execution context).
- **Stable identity** separating a logical source from an immutable account.
- **Immutable, append-only Evidence** — sealed accounts never mutate.
- **Provenance and Coverage as grounds** (never computed verdicts).
- **Versioning** — every Type and dependency is versioned and pinned.
- **Deterministic Normalize** — same inputs + same pinned context → same accounts.
- **Full, comparable Replay** — a manifest reproducing the complete run identity.

## 2 · Construction history (commits, in order)

```text
50be8c0 — PR1 Core Contracts
6dc6d6c — PR1 Closure Report
e8d2e00 — PR1 Closure correction (PR2 = Versioned Registries)
866a8c1 — PR2 Versioned Registries
95c5a4c — PR2 Closure Report
7c92025 — PR3 Normalize + Coverage contract correction
036c5a7 — PR3 Closure Report
cf771fa — Typed Normalization Rejection Identities (PR4 prerequisite)
82cd5e9 — PR4 Replay Harness / Execution Modes
bbe4d20 — PR4 Closure Report
(this document — C0 Final Construction Report — commits next)
```

## 3 · Final architecture (the pipeline as built)

```text
RawInput (fixture)
→ TranslatorProjection            (Business Concept, never feature vocabulary)
→ Concept Version Resolution      (by observationTime, against the pinned snapshot)
→ ValueShape Validation
→ Provenance Validation           (RealityTier validity + structural anti-laundering)
→ Coverage Resolution             (explicit entry required; NO_ENTRY → rejection)
→ Identity Binding                (RESOLVED / SIGNAL_ONLY / UNRESOLVED)
→ Confidence Grounds
→ sealObservation()               (deep-frozen)
→ CanonicalObservation Account    (immutable, append-only)
→ ReplayOutcomeSet                (accounts + typed rejections)
→ ReplayManifest                  (deterministic, dependency-pinned, golden-locked)
```

## 4 · Contracts locked

- **Three identifiers:** `sourceObservationId` (logical source), `canonicalHash` (content
  fingerprint), `observationAccountId` (immutable account).
- **Source identity ⟂ content identity** — different formulas, different roles.
- **One Account → one content → one ExecutionContext**, forever (deep-frozen).
- **One Logical Source → many append-only sibling Accounts.**
- **No `supersession` in C0** — later layers decide which account wins.
- **Unknown is not an Observation** — it is a typed rejection or a downstream gate.
- **Missing ≠ negative.**
- **`NO_ENTRY` ≠ `UNCOVERED`** — a missing coverage entry is a typed rejection, never a
  fabricated UNCOVERED account.
- **Coverage grounds are not T1/T2/T3** — those belong to the Observability Ontology.
- **ConfidenceBasis is grounds, not a computed confidence.**
- **Field-level provenance cannot be laundered** (structural rules; no tier ranking).
- **RealityTier has no ranking in C0.**
- **Replay identity includes successes AND typed rejections.**
- **Every dependency that could change Normalize must be pinned** (12 pinning reasons).

## 5 · Golden Contract Register (in full)

```text
Source Observation ID
  src_b9f11aaf0cee99d7399c90f33425189da4c0359a199fa42d0b8f3e3773aa396b
  Protects: the source-identity formula (source anchor only; stable under content/context change).

Canonical Hash
  sha256:fa0af469296d05f0827fb0802392fb92cf4a21abafded3e397ff84f5ef015159
  Protects: canonical serialization + full COT content fingerprint (incl. context).

Observation Account ID
  acc_d95caf5e63d79ccc55b2abd4ae2deb2a23b95a0ba0ed23b18cdd47397bf77e47
  Protects: the immutable-account identity (hash of source id + canonicalHash).

Concept Snapshot Digest
  regsnap:concept:sha256:57611431a8994e7018e293edae4f0531f8c41fb1b47948372fcde5cb336824aa
  Protects: registry snapshot digest (registryKind + snapshotSchemaVersion + sorted entries).

Replay Manifest Digest
  replaymanifest:sha256:443cf151d72b4a2f32f25e437472aed7b4259fdb0903490438636c7fb1193f1c
  Protects: the full run identity (dependency context + ordered accounts + ordered typed rejections).
```

## 6 · Test Register

| Script | Covers |
|---|---|
| `verify:brain-c0` | identity formulas, determinism, idempotency, fan-out, inference-act, deep freeze, cycle guard, COT golden vector |
| `verify:brain-registries` | 5 versioned registries, immutability, snapshot determinism, frozen, typed lookups, no-tenant, concept snapshot golden |
| `verify:brain-normalize` | full Normalize pipeline (~28 scenarios), typed rejections + identity fidelity, coverage NO_ENTRY vs UNCOVERED, exhaustiveness |
| `verify:brain-replay` | 12 pinning reasons, manifest identity (accounts+rejections), historical replay match/divergence, reprocess siblings, inference freeze, timeline, replay golden |

- **Golden Vectors** (5) are hard-coded literals compared directly to runtime output — any
  silent change to serialization, field inclusion, an identity formula, a snapshot digest,
  or the full run identity breaks them on purpose.
- **Focused TypeScript gate:** `tsc --strict` over all `lib/business-brain/**` = 0 errors
  (run from a repo with `@types/node`).
- **Not yet tested against Production:** no live sensors, no real translators, no DB, no
  real RealityTier vocabulary — all fixtures.

## 7 · Definition of Done — C0

C0 is Complete only if ALL hold:

1. All four verifies green.
2. Focused tsc over `lib/business-brain/**` clean.
3. Worktree clean.
4. All closure docs committed.
5. No imports from Prisma / DB / live Services / LLM/OCR SDK.
6. No external runtime changes.
7. No unreviewed changes under `lib/business-brain/`.
8. All five Golden Literals match the locked values.
9. Branch history contains only Brain work.

## 8 · What C0 guarantees

- Reproducibility within a locked dependency epoch.
- Deterministic account identity.
- A full, comparable Replay Manifest (successes + typed rejections).
- Immutable Evidence accounts (deep-frozen, append-only).
- Typed failures (no generic errors, no silent fallback).
- Tenant isolation at the identity level (tenant in the source anchor; registries tenant-free).
- Forward-safe Unknown handling (Unknown is never a fabricated observation).

## 9 · What C0 does NOT guarantee

- No persistence. No production translators. No DB backfill.
- No Detection Grammar runtime. No Partition/Window/Sequence. No Phenomena.
- No Beliefs. No Judgment. No computed confidence score. No semantic matrices.
- No canonical production RealityTier registry. No Learning Engine. No Product Intelligence.
- No live sensor liveness. No open-interval EventTime.

## 10 · Deferred Register (consolidated PR1–PR4)

**C1 prerequisites:** Detection Grammar runtime; Partition/Window/Sequence/Baseline; the
Observability Ontology (T1/T2/T3 derivation); Phenomena.

**Future Construction:** ConfidencePolicy (computed confidence/ceiling); production
translators; persistence of accounts/manifests; canonical RealityTier vocabulary registry;
eager validation of overlapping concept effective-ranges (currently lazy →
`CONCEPT_VERSION_AMBIGUOUS`).

**Governance:** referent↔concept and aspect↔referent semantic matrices (need an approved
source of truth); Brain family governance under WP9 (open from Discovery).

**Production integration:** live sensors, DB, real inference wiring, deployment provenance.

**Known limits (non-blocking):** open-interval EventTime; `translatorContractDigest` locks
the declared contract, not runtime-code; `RejectionDetailsDigest` reserved but unused
(rejection identity already fully typed).

## 11 · C0 → C1 boundary map

**C1 may receive:**

```text
readonly CanonicalObservation accounts
+ ReplayManifest / ExecutionContext
+ Versioned Type Registries
```

**C1 must NOT:**

- mutate a COT or Evidence;
- change an existing Registry version;
- fabricate Coverage;
- turn Unknown into negative;
- re-run inference during Replay;
- bypass typed failures;
- use Feature vocabulary instead of Business Concepts.

## 12 · Construction Status

```text
Discovery                         ✅ Closed
C0 Core Contracts                 ✅ Complete
C0 Versioned Registries           ✅ Complete
C0 Normalize                      ✅ Complete
C0 Replay Harness                 ✅ Complete
C0 Production Persistence         Not started
C1 Detection Grammar Runtime      Not started
```
