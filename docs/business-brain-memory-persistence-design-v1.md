# Dubiz — Business Memory Persistence Design v1

> **Status: PRE-IMPLEMENTATION DESIGN — NOT SCHEMA.** Logical persistence design implementing `business-brain-evidence-memory-contract-v1.md` (RATIFIED) + `business-brain-memory-architecture-v1.md`. **No Prisma / SQL / migration / code.** `logical record` = a contract shape, explicitly not a table.
> **Source hierarchy:** Contract v1 (governs) → Architecture v1 → this design → Product-Truth/repo. v0 + ratification-v0 = history only.
> **Baseline:** `origin/main e7150c1`; firsthand-revalidated, unchanged.

---

## 1. Purpose / Status
Translate Contract v1 + Architecture v1 into a **logical persistence design** that preserves all 18 invariants, and **decide the canonical evidence source** — without choosing schema/serialization. Everything physical is deferred to the Implementation Substrate stage.

## 2. Persistence Principles
1. **Canonical ≠ derived.** Two persistence tiers, never mixed (Contract §5).
2. **Canonical is append-only + provenance-bearing.** Nothing derived rewrites it.
3. **Derived is droppable + rebuildable** from canonical + policy versions.
4. **Evidence wins.** A materialized value never overrides its evidence (INV-8).
5. **Tenant-scoped everywhere** (INV-9).
6. **Every derived record links to its evidence set + policy version** (INV-1/2/10).

## 3. Canonical vs Derived Boundary
| CANONICAL (authoritative, append-only, retained) | DERIVED (disposable, rebuildable) |
|---|---|
| owner decisions/corrections · engine-belief context (inference evidence) · provenance · **derivation-policy versions** · reasoning provenance/run-identity (when C1) · **erasure/superseding facts** | Business-Memory **Claims** · derived **state** · derived **confidence** · **explanation index** · caches/materializations |

## 4. Logical Record Model (contract shapes — NOT schema)
| Logical record | Canonical/Derived | Mutable? | Tenant | Identity | Versioning | Retention | Rebuild role | Authority |
|---|---|---|---|---|---|---|---|---|
| **Owner-Decision Evidence** *(= `ReviewEvent`)* | canonical | immutable/append-only | businessId | (doc, occurredAt, reviewer) | schema-versioned | permanent | **primary input** | authoritative |
| **Engine-Belief Evidence** *(= `ExtractionSnapshot`/`SliceDecision`)* | canonical | append-only | businessId | (doc, occurredAt) | engine-versioned | permanent | context/explanation | non-authoritative (belief) |
| **Derivation-Policy Version** | canonical | immutable | (global-defs) / tenant-applied | policyName@version | **is the version** | permanent | selects derivation | governance-authored |
| **Reasoning-Provenance Ref** (only if C1 used) | canonical | immutable | businessId | (operator@version, runId) | contract-versioned | permanent | pins reasoning input | non-authoritative |
| **Erasure / Supersession Fact** | canonical | append-only | businessId | (target evidence ref, occurredAt) | — | permanent | invalidates derivations | authoritative |
| **Derived Claim** | derived | rebuildable (drop+re-derive) | businessId | (subjectKey, policyVersion) | pins policyVersion | droppable | the output | non-authoritative |
| **Claim↔Evidence Link** | derived | rebuildable | businessId | (claimRef, evidenceSetRef) | — | droppable | explanation | non-authoritative |
| **Subject / Alias Reference** | canonical (mapping) | append-only | businessId | domainLocalKey \| referentId | — | permanent | late-binding | mapping |

## 5. Evidence-Source Decision (the central OPEN)
**Firsthand facts:** `ReviewEvent` (append-only; owner-final vendor/direction + `verdicts` incl. category + lossless raw; written at **approve**) · `ExtractionSnapshot`+`SliceDecision` (append-only; engine belief + provenance + `extractionOutcome` incl. failures; written at **doc creation**) · both tenant-scoped, joinable by `documentId`. `C0 CanonicalObservation` = formal substrate, **not persisted** (inert). The ledger writers are *"strictly additive, append-only"* but **best-effort** (non-fatal on failure).

**Verdict:**
- **`ReviewEvent` IS the canonical OWNER-DECISION evidence** — the authoritative learning signal for Business Memory. **(decided.)**
- **`ExtractionSnapshot`/`SliceDecision` are canonical ENGINE-BELIEF (inference) evidence** — non-authoritative context, valuable for explanation and anti-survivorship, **not** the learning signal.
- **Duplication:** minimal and *legitimate* — owner-final vs engine-belief are **different evidence kinds**, not copies.
- **A unified evidence log is NOT required for v1**; **C0 persistence is NOT required for v1** (domain-local vendor→category needs no cross-feature canonicalization).
- **Coverage caveat (UNVERIFIED):** because the ledger is best-effort and post-dates some approvals, `ReviewEvent` may **not** cover all historical approvals → full rebuild of *historical* memory from evidence may be incomplete (affects VendorLearning backfill, §14).

## 6. Claim Materialization Design
Options: **Materialized** (stored for reads) · **Fully-derived on-read** · **Hybrid** (canonical evidence + rebuildable claim cache).
- `decideCategory` runs on the **hot extraction path** → on-read re-scan of every ReviewEvent per document is a perf cost.
- **Recommendation: HYBRID** — persist Claims as a **rebuildable cache** (fast reads), authoritative source stays the evidence+policy. Cache is droppable; on any conflict, evidence wins; policy-version change → re-derive. Migration-safe (cache can be dropped/rebuilt without touching evidence).

## 7. Derived-State Persistence
States `supported / conflicting / insufficient / withdrawn` are **derived**. Persist them **only as part of the materialized Claim** (a cache), always recomputable on-read/rebuild. **Forbidden as persisted authority:** `active / current / latest / preferred / selected` — they encode latest-wins (INV-8). No new justification exists to add them.

## 8. Confidence Persistence
Confidence = derived (no formula chosen). Persistence semantics: **stored confidence, if present, is a cache/materialization only.** Source-of-truth = the evidence set + policy version. Persist alongside the Claim the **inputs reference + policyVersion**, so a formula change re-derives without ambiguity. If the formula changes, stored confidence is **stale cache** → re-derived (INV-7).

## 9. Derivation-Policy Persistence
- **Identity:** `policyName@version`; **version identity is immutable** once published.
- **Relation to Claim:** each materialized Claim pins the `policyVersion` that produced it.
- **Historical replay:** a Claim replays under its pinned version; a fresh rebuild may use the current version (and is explainable as such).
- **Retirement/supersession:** a retired policy version remains resolvable (append-only registry); superseding a version is a new version, **never** a mutation. **No latest-policy-wins without provenance** — selection of "which version applies" is governance-defined, not row-order.
- *(Serialization deferred.)*

## 10. Evidence-Link Model
A Claim references its basis via a **derivation-run reference** carrying the **evidence-set identity** (the set of canonical evidence record ids it read) — **not** copied raw evidence. This answers *"exactly which evidence caused this Claim?"* by dereferencing to the append-only records. Raw evidence stays in the canonical tier; the Claim holds references only (INV-10/13).

## 11. Identity / Subject Persistence
**One Subject abstraction, two reference forms** (no second engine):
- `SubjectRef = domainLocal(businessId, normalizedKey)` — e.g. vendor (no RIA).
- `SubjectRef = canonicalReferent(businessId, referentId)` — cross-domain (RIA).
- **Alias record (canonical, append-only):** binds a domainLocal key to a referentId when RIA later resolves it. **Late binding:** a new referent-keyed Claim is **derived over the same existing evidence**; the alias is appended; **no evidence/history rewrite** (Contract §6/§10). One abstraction serves both; RIA is not redesigned.

## 12. Tenant Isolation
Every canonical **and** derived record carries `businessId`. Constraints: an evidence→Claim link must be **same-tenant**; a Claim's evidence set is same-tenant; rebuild is per-tenant; **no cross-tenant link is representable**. Platform static/versioned rules (if ever) are a **separate record family**, never a Claim, never fed by a tenant's evidence (INV-9).

## 13. Erasure / Privacy Compatibility (mechanism deferred)
- **Canonical remains:** the erasure/supersession **fact** (that some evidence is no longer admissible) is itself append-only canonical.
- **Derived must drop/re-derive:** materialized Claims depending on erased evidence are dropped and re-derived to `withdrawn`/`insufficient` (INV-14).
- **How a Claim knows:** its evidence-set reference (§10) now resolves to superseded/erased items → the Deriver excludes them.
- **Rebuild:** honors erasure facts (excludes erased evidence). **The concrete erasure representation is deferred** (coupled to RIA's OPEN erasure question) — the design is only required to be *compatible*, which it is.

## 14. VendorLearning — Persistence Transition (conceptual only)
- **Canonical in current `VendorLearning`:** **almost none** — it is a derived counter (`usageCount`/`confidence`/`category`). The canonical owner decisions live in `ReviewEvent`s.
- **`usageCount` rebuildable from ReviewEvents?** **Yes** (count of confirming owner-decision evidence per subject) — **where ReviewEvent coverage exists** (§5 caveat).
- **`confidence` rebuildable?** **Yes** (derived function of the ReviewEvent set).
- **Existing rows at a future migration → recommended handling: DISCARD-and-BACKFILL-from-evidence, with compare-and-audit.** Rebuild Claims from `ReviewEvent`s; **audit** the rebuilt Claim against the legacy row to surface coverage gaps; for subjects with **no** ReviewEvent history (pre-ledger/best-effort-miss), the legacy row is **not** authoritatively recoverable → treat as **discarded or unverified seed** (owner decision, §OPEN).
- **learning-first read path (`decideCategory`): KEEP** — it reads the materialized **Claim** (with state + explanation) instead of the `VendorLearning` row.
- **No migration plan / no SQL** — transition design only.

## 15. Existing-Store Verdict (ReviewEvent vs SliceDecision vs ExtractionSnapshot)
- **Canonical owner-decision:** `ReviewEvent` (authoritative learning signal).
- **Raw/derived engine context:** `ExtractionSnapshot` (+`SliceDecision` per-field) — engine belief, non-authoritative.
- **Duplication:** minimal/legitimate (different evidence kinds; joinable by `documentId`).
- **Source-of-truth for Memory:** `ReviewEvent` (owner) as the learning signal; ExtractionSnapshot for explanation/context.
- **Unified evidence record required?** **Not for v1** — deferred; the §11/§10 references + §18 adapter make a future unification non-breaking.

## 16. Constraint Matrix (logical)
- **no cross-tenant evidence links** (INV-9) · **no derived knowledge without an evidence set** (INV-1) · **no Claim without a policy version** (INV-2) · **no confidence as authority** (INV-7) · **no evidence rewrite** (INV-13, append-only) · **no tenant-learned knowledge marked global** (INV-9) · **no cascade-deletion of canonical evidence driven by derived state** (evidence outlives claims) · **derived state/claims are droppable** (INV-8) · **every explanation reference resolves to a live canonical record** (INV-10) · **erasure facts are canonical and honored on rebuild** (INV-14).

## 17. Failure Scenarios → canonical/discarded

| Scenario | Canonical (kept) | Derived (dropped/re-derived) |
|---|---|---|
| duplicate evidence | both evidence rows kept (append-only) | Claim re-derived (dedup is a derivation concern) |
| conflicting owner decisions | all ReviewEvents kept | Claim → `conflicting` |
| materialization references missing evidence | evidence is source-of-truth | that Claim is invalid → re-derive |
| cache corruption | evidence intact | drop cache → rebuild |
| policy-version unavailable | evidence + registry kept | cannot derive under that version → surfaced, not guessed |
| RIA binding changes | evidence + alias kept | referent-keyed Claim re-derived over same evidence |
| erasure | erasure fact kept; erased evidence superseded | dependent Claim → `withdrawn` |
| cross-tenant link attempt | rejected (unrepresentable) | — |
| failed partial rebuild | evidence intact → idempotent retry | partial materialization discarded |
| VendorLearning row disagrees with rebuilt memory | ReviewEvents are truth | legacy row discarded/audited (§14) |

## 18. Alternatives

| | P1 · Existing Ledger Reuse | P2 · Unified Canonical Log | P3 · C0 Persistence First | P4 · Hybrid Adapter |
|---|---|---|---|---|
| correctness | 4 | 5 | 5 | **5** |
| complexity | **5** (lowest) | 2 | 1 | 4 |
| migration risk | **5** (lowest) | 2 | 1 | 4 |
| duplication | 4 | 5 | 4 | **5** |
| replay | 4 | 5 | 5 | **5** |
| cross-domain extensibility | 2 | 5 | 5 | **5** |
| time-to-first-real-memory | **5** | 2 | 1 | 4 |

> **Recommendation: P1 executed *through* a P4 adapter seam.** Reuse `ReviewEvent` (+ExtractionSnapshot context) as canonical evidence **now** (lowest risk, fastest real memory, no duplication), but have Business Memory read evidence **only through a stable Evidence-Reference/Adapter** (§10/§11) — so the canonical source can later be promoted to a unified log (P2) or C0 (P3) **without touching Memory**. This gets cross-domain extensibility (adapter can serve referent-keyed evidence) without paying P2/P3's cost before there is a consumer.

## 19. Persistence Boundary (the hard line)
- **MUST be persisted canonically:** owner decisions (`ReviewEvent`) · engine-belief evidence (`ExtractionSnapshot`/`SliceDecision`) · derivation-policy versions · reasoning provenance (when C1) · erasure/supersession facts · subject-alias mappings.
- **MAY be persisted as materialization:** Derived Claims · derived state · derived confidence · explanation index · caches.
- **MUST NOT be persisted as authority:** any materialized claim/counter/confidence as source-of-truth · `isGlobal` on tenant-derived knowledge · any `current/latest/preferred` precedence.
- **Implementation-deferred:** physical schema/serialization · unified-log build · confidence formula · concrete erasure mechanism · rebuild worker/queue/triggering · the SubjectRef/alias physical representation.

## 20. OPEN Questions (owner / next stage)
1. **OD-P1 — adopt P1+adapter** (reuse ledger now) **vs** build a unified canonical log first? *(Recommendation: P1+adapter.)*
2. **OD-P2 — VendorLearning backfill policy** given `ReviewEvent` coverage is **UNVERIFIED** for historical approvals: discard, backfill-where-covered, or backfill+seed? *(Recommendation: backfill-where-covered + audit; discard/seed the uncovered tail.)*
3. **OD-P3 — Derivation-Policy registry** — stand it up as a canonical store now, or inline the first policy version and defer the registry?
4. Canonical persistence for the derivation-run/evidence-set reference (§10) — reference-set vs run-id — deferred to substrate.
5. Confidence formula · concrete erasure mechanism — deferred (Contract).

## 21. Next-Stage Gate
**Business Memory Implementation Substrate** — the first inert, additive persistence artifact (e.g. the materialized-Claim projection + policy-version reference + evidence-reference adapter), **only after** OD-P1/OD-P2/OD-P3 are decided. That stage will choose schema; this stage does not.

---

## Verdict
The **central question is answered**: the canonical evidence source is `ReviewEvent` (owner decisions) + `ExtractionSnapshot`/`SliceDecision` (engine-belief context); Business Memory adds a **derived, rebuildable Claim materialization** via a P1+adapter seam; all 18 invariants map to the canonical/derived boundary. It is **not blocked** (canonical source is clear → not C). It is **not** fully A, because three real owner decisions remain (OD-P1 adapter-vs-unified-log, OD-P2 backfill policy given **UNVERIFIED** ReviewEvent history coverage, OD-P3 policy-registry-now-vs-later) that shape the substrate.

> **B — READY WITH OWNER DECISIONS.**

---

*Persistence Design v1 · PRE-IMPLEMENTATION — NOT SCHEMA. Implements Contract v1 + Architecture v1. No Prisma/SQL/migration/code; VendorLearning unmodified; no C0/RIA activation. Implementation Substrate is a separate stage pending owner decisions.*
