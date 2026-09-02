# Dubiz — Business Memory Architecture v1 (Architecture Only)

> **Status: PROPOSED ARCHITECTURE — for owner review.** Implements `docs/business-brain-evidence-memory-contract-v1.md` (RATIFIED). Where any tension arises, **Contract v1 governs**.
> **Type:** logical architecture — components, boundaries, information flow. **NOT** Persistence Design, **NOT** implementation. No Prisma/tables/columns/indexes/migration/API/worker.
> **Baseline:** `origin/main e7150c1`; Contract-v1 assumptions firsthand-revalidated and unchanged.

---

## 1. Purpose / Non-Goals
- **Purpose:** define how Dubiz turns **Canonical Evidence → Derived Business Memory → Recommendation**, preserving `Evidence ≠ Memory ≠ Recommendation ≠ Owner Decision ≠ Action` and one-directional authority.
- **Non-goals (deferred to Persistence Design):** Prisma models, table/column names, indexes, JSON-vs-relational, migrations, cache/queue/cron/worker tech, API routes, a confidence formula, the concrete erasure mechanism, C1 expansion. Any `logical record` below is a **contract shape**, explicitly **not** a persistence schema.

## 2. Authority Model (unchanged from Contract v1)
Authoritative: **Evidence** (facts) + **Owner Decisions**. Non-authoritative: inference, confidence, learned knowledge, recommendation, every materialized row. Authority is **one-directional** — nothing derived rewrites evidence or becomes truth.

## 3. Logical Architecture (two sides, one seam)
```
        CANONICAL SIDE (authoritative, append-only)      │      DERIVED SIDE (disposable, rebuildable)
────────────────────────────────────────────────────────┼──────────────────────────────────────────────
 Evidence Log (observations · owner decisions ·          │
   reasoning inputs) + Provenance + Policy-Version reg.   │
                        │  (read-only)                    │
                        ▼                                  │
                 [1] Evidence Reader ───────────────────► [3] Memory Deriver ◄─── [2] Derivation Policy (versioned)
                        (tenant-scoped)                    │        │  pure(evidence set, policyVersion)
                                                           │        ▼
                                                           │  [4] Materialized Knowledge Projection (cache)
                                                           │        │
                                                           │        ▼
                                                           │  [5] Explanation / Provenance  ──► "why does Dubiz think this?"
                                                           │        │
                                                           │        ▼
                                                           │  [6] Recommendation Consumer ──► owner
                                                           │        ▲
                                                           │  [7] Rebuild / Reprojection (drop cache → re-derive)
 owner decision ──────────────────────────────────────────  becomes new Evidence (append) ──┘
```
The **seam** is Contract v1 §6: only evidence items cross from Canonical into Derived. Nothing derived crosses back.

## 4. Component boundaries

| # | Component | Responsibility | Inputs | Outputs | Authority | MUST NOT | Side |
|---|---|---|---|---|---|---|---|
| 1 | **Evidence Reader** | expose the append-only evidence set for a subject, tenant-scoped | subjectKey, businessId | ordered evidence set (immutable) | reads canonical | write/mutate evidence; cross tenants | canonical (read) |
| 2 | **Derivation Policy (versioned)** | the pure rule turning an evidence set into a claim+state+confidence+explanation | — (it *is* the rule) | a versioned function identity | derived rule | depend on wall-clock, row-order, or "latest"; hold state | derived |
| 3 | **Memory Deriver** | apply a policy **version** to an evidence set → claims | evidence set + policyVersion | derived Claim(s) | derived | invent evidence; treat its output as truth; use unversioned policy | derived |
| 4 | **Materialized Knowledge Projection** | cache derived claims for fast reads | derived claims | cached claims (droppable) | **cache only** | be the source of truth; override its evidence; survive erasure of its basis | derived (cache) |
| 5 | **Explanation / Provenance** | answer "why" by walking claim→derivation→evidence(→reasoning run) | a claim | evidence set + policyVersion (+ reasoning identity) | derived | present confidence *as* the explanation | derived |
| 6 | **Recommendation Consumer** | turn claims (+state/confidence/explanation) into a suggestion | claims | recommendation to owner | derived, owner-facing | decide; act; hide state/conflict | derived |
| 7 | **Rebuild / Reprojection** | drop materialization and re-derive from canonical + policy versions | evidence + policy-version reg. | fresh materialization | mechanical | change evidence; produce a different result than the pinned derivation | derived |

**Few components, strong seams** — not a framework. The Evidence Log/Provenance/Policy-Version registry on the canonical side are *sources* the Reader consumes; their **persistence is the next stage** (§18).

## 5. The Knowledge Unit — the **Claim**
Minimal learned-knowledge unit = a **Claim**: a *derivation over an evidence set*, never authoritative.
```
Claim (logical contract shape — NOT a schema) {
  subject        : SubjectKey            // what it is about (§8)
  proposition    : predicate + value     // what is claimed, e.g. category = "office"
  derivedFrom    : { evidenceSetRef, policyVersion, reasoningRefs? }
  state          : DerivedState          // §6 — derived, not stored lifecycle
  confidence     : derived (explainable) // §Contract 9
  tenant         : businessId
}
```
- **Subject** = the thing the knowledge is about (a domain-local key **or** a canonical referent — §8).
- **Proposition/claim** = the learned statement (e.g. `(vendor V) → category C`).
- **Evidence support** = the referenced evidence set (owner decisions + observations + reasoning inputs) that the derivation read.
- **Evidence conflict** = the evidence set supports incompatible propositions → `state = conflicting` (the Claim does **not** silently pick a winner).
- **Which policy** = `derivedFrom.policyVersion` (INV-2).
- **"Current projection" without latest-wins** = *the derivation of the current policy version over the current evidence set* — deterministic; there is **no** stored `current/active/latest/preferred` flag (INV-8/§6).
- **Insufficient evidence** → `state = insufficient`. **Owner correction** → new evidence → re-derive. **Erasure** → dependent evidence withdrawn → re-derive to `withdrawn` (INV-14). **Rebuild** = re-run the derivation from evidence+policy (§12).

> No general ontology is introduced — the Claim shape is the minimum the vendor→category and cross-domain use-cases require.

## 6. State / Conflict Model (derived, not a status machine)
States are **derived functions of the evidence set + policy version**, computed at derivation time — **not** a stored lifecycle:
- **supported** — the evidence coherently supports one proposition.
- **conflicting** — the evidence supports incompatible propositions.
- **insufficient** — too little / no admissible evidence.
- **withdrawn** — the derivation's supporting evidence was erased/invalidated (INV-14).

**Proof of necessity (from use-cases + Contract):** conflicting corrections over time (Contract scenario 2) require `conflicting`; a fresh subject (scenario 10) requires `insufficient`; erasure (scenario 5) requires `withdrawn`; the normal case requires `supported`. Four states, each contract-forced.
**Forbidden:** `ACTIVE / CURRENT / LATEST / PREFERRED / selected` or any stored precedence — they smuggle latest-wins (violates INV-8/§6). *(A Claim that is later replaced by a new derivation is simply the new derivation; "superseded" is a relationship between derivations, not a stored status.)*

## 7. Derivation Policy Model
- **A derivation policy is** a named, **pure** function `(evidence set) → {proposition, state, confidence, explanation}`, deterministic given the evidence set. It holds no state and does not read wall-clock or insertion order.
- **Version identity** = a stable `policyName@version`. **A policy change** = any change to the function's semantics (admissibility, weighting, conflict rule, confidence derivation) → a **new version**.
- **Knowledge links to the version** that produced it (`Claim.derivedFrom.policyVersion`).
- **On policy update:** existing Claims are **not mutated**; they replay under their pinned version; new/rebuilt Claims use the new version. Evidence is untouched (INV-1/2/13).
- **Rebuild knows which policy** via the Policy-Version registry (a source on the canonical side); historical explanation uses the pinned version, fresh derivation uses current.

## 8. Provenance / Explainability
Every Claim answers *"why does Dubiz think this about this business?"* via the chain:
```
Claim → Derivation(policyVersion) → Evidence set → { owner decisions, observations, reasoning inputs }
                                                  → (if C1 used) reasoning contract-version + run identity
```
- The explanation is the **evidence + policy version**, never the confidence number (INV-7/10; Contract §9).
- If reasoning participated, the explanation includes the reasoning **version/run identity** (INV-16), so a changed reasoning result is visibly a *different input*, not a silent mutation.

## 9. Tenant Model (INV-9)
Every component is **tenant-scoped**: evidence read filtered by `businessId`; derivation per-tenant; Claim carries `tenant`; recommendation per-tenant; rebuild per-tenant. **No cross-business evidence set, no cross-business aggregation, no `isGlobal` on tenant-derived knowledge.** Any platform default (if ever needed) is a **separate static/versioned-rules path** (sibling to the existing `CATEGORY_RULES`), never fed by one tenant's corrections and never a Claim.

## 10. RIA Boundary (RIA optional — INV-11)
The Subject key has two forms; the **same Memory** serves both (no second engine):
- **A · Domain-local** — `SubjectKey = domainLocal(businessId, normalizedVendorName)`. **No RIA.** (vendor→category.)
- **B · Cross-domain** — `SubjectKey = canonicalReferent(referentId)` when the subject spans feature domains (same vendor via OCR + Supplier + WhatsApp + bank). **RIA required** only to establish the referent.
- **Late binding:** if a domain-local Claim later gains a RIA referent, a **new projection** is derived, keyed on the referent, **over the same existing evidence**; the domain-local key is recorded as an **alias** of the referent. **No evidence or history is rewritten** (Contract §6/§10).

## 11. C0 / C1 Boundary (no forced coupling)
- **Raw/domain evidence is sufficient** when the fact is simple, single-domain, and needs no cross-feature comparability (a vendor string on one document).
- **C0 CanonicalObservation is useful** when evidence needs canonical provenance/immutability/replay or must be compared across feature domains (the base for RIA/cross-domain).
- **C1 reasoning is an optional evidence-derived input** for structured cases (interval/partition/equality readouts) — never a stage Memory must pass through.
- **Memory must not depend on C1** (INV-12): the Deriver consumes reasoning outputs only when present, as version-pinned inputs.
- **C1 replay/version change does not rewrite knowledge** (INV-16): a changed reasoning result is a new input; prior Claims replay under their pinned inputs.

## 12. Rebuild Semantics
**"Drop all materialized Business Memory and rebuild it"** means: discard component [4]; for each subject, [1] read the evidence set, [2/3] apply the pinned or current policy version, re-derive Claims.
- **Must remain (canonical):** the append-only Evidence Log + Provenance + Policy-Version registry + reasoning provenance + erasure facts.
- **May be deleted:** all materialized projections (component [4]).
- **Policy versions participate:** historical replay uses pinned versions; a full rebuild may use the current version (and is explainable as such).
- **Erasure participates:** erased evidence is absent/superseded → dependent Claims re-derive to `withdrawn` (INV-14).
- **Reasoning provenance participates:** pinned reasoning inputs reproduce the same derivation (INV-16).
- **Full rebuild and incremental rebuild are the same semantic operation** — a derivation over an evidence set — differing only in **scope** (all subjects vs the subjects touched by new evidence). *(Triggering/worker is Persistence-Design, deferred.)*

## 13. VendorLearning — Retrofit Walkthrough (end-to-end, no code)
```
Document/OCR extraction
  → owner review/approve/correct           → append CANONICAL EVIDENCE (ReviewEvent — already append-only)
  → Evidence Reader (business, vendor)      → the ordered ReviewEvent set for that subject
  → Memory Deriver × "vendor-category-policy@v1"
       supported / conflicting / insufficient + derived confidence + explanation
  → Claim: (business, vendor) → category    → Materialized Projection (rebuildable cache)
  → decideCategory reads the Claim (learning-first, WITH state + explanation)
  → recommendation → OWNER decision
  → new ReviewEvent (evidence)              → re-derivation (INV-1/3)
```
**Disposition per existing responsibility:**

| Existing responsibility | Disposition | Why |
|---|---|---|
| vendor→category use-case | **KEEP** | correct, wanted |
| learning-first read in `decideCategory` | **KEEP** (reads a Claim, not a counter) | right integration point |
| `ReviewEvent` capture of owner correction | **KEEP** | already conformant canonical evidence (append-only) |
| `VendorLearning` mutable counter (`usageCount`/`confidence`) | **REPLACE** with a rebuildable Projection | violates INV-1/7/8 |
| `upsert` overwrite of prior category | **RETIRE** | evidence is append-only; conflict → `conflicting`, no rewrite (INV-13) |
| stored arbitrary `confidence` (`0.8`/`+0.02`) | **REPLACE** with derived confidence | INV-7 |
| `isGlobal` for tenant-derived learning | **RETIRE** | INV-9 |
| parallel hidden write path (counter ≠ evidence) | **MIGRATE** to: append evidence → derive Claim | INV-10 |
> No migration SQL, no code change — this is the reference vertical proving the architecture explains a live use-case.

## 14. Failure / Conflict Scenarios → Invariants preserved

| Scenario | Architecture response | Invariants held |
|---|---|---|
| consistent evidence | derive `supported`, confidence rises | 1,7,10 |
| conflicting evidence | derive `conflicting`; history retained | 6,8,13 |
| owner changes decision | new evidence appended → re-derive | 3,13 |
| materialized memory lost | Rebuild from evidence+policy | 1,8 |
| derivation-policy changed | pinned replay + new-version rebuild | 1,2 |
| evidence erased | withdrawn derivation | 14 |
| C1 output changed | new pinned input; old Claims replay | 16 |
| RIA binding added late | new referent projection over same evidence; alias; no rewrite | 11,13 |
| two tenants, similar evidence, different outcomes | tenant-scoped derivation; no cross-tenant | 9 |
| insufficient evidence | derive `insufficient`; no recommendation asserts fact | 4,6 |

## 15. Architectural-Invariant Mapping (all 18 preserved)
1 rebuildable→[7]/§12 · 2 policy-versioned→[2]/§7 · 3 owner-decision=evidence→§13/canonical · 4 silence≠approval→evidence only on owner action · 5 five-entities-distinct→§3 seam/[6] · 6 knowledge≠truth→[3] derived · 7 confidence≠authority→[5]/§6 states · 8 materialized=disposable/evidence-wins→[4]/[7] · 9 tenant-local→§9 · 10 explainable→[5] · 11 RIA-optional→§10 · 12 C1-optional→§11 · 13 evidence-not-rewritten→canonical append-only · 14 erasure-invalidates→§6 withdrawn/§12 · 15 irreversible-action=evidence→owner-action append (§13 loop) · 16 reasoning-provenance→§8/§11 · 17 authority-one-directional→§2 seam · 18 no-autonomous-action→[6] owner decides.
> **All 18 invariants map to a component/boundary. None is violated by the architecture.**

## 16. OPEN Questions (for owner / next stage)
1. **Canonical evidence source of record** — is the Evidence Log a promotion/union of `ReviewEvent` (+`SliceDecision`), or a new unified evidence log? *(Persistence-Design; the architecture only requires "an append-only evidence set per subject with provenance".)*
2. **Policy-Version registry** shape/ownership (who authors/ratifies a derivation policy version).
3. **Erasure representation** — the concrete "superseding erasure fact" (tied to RIA's OPEN erasure question).
4. **Incremental-rebuild triggering** — event-driven vs on-read vs scheduled (Persistence-Design).
5. **Confidence function** — still deferred (Contract).

## 17. Persistence-Design Inputs (what the next stage must decide)
- storage for: the append-only Evidence Log, the Materialized Projection (cache), the Policy-Version registry, the Explanation index;
- the canonicalization of `ReviewEvent`/`SliceDecision`/`ExtractionSnapshot` into the Evidence Log (or a new log);
- the SubjectKey representation (domain-local vs referent) and the alias table for late-binding;
- rebuild execution (on-read vs materialized vs worker) — **all deferred here.**

---

## Readiness
All 18 Contract-v1 invariants map to a component with a strong boundary; the Claim is the minimal knowledge unit; the state model is derived (no latest-wins); RIA/C1 are optional; rebuild is a single derivation semantic; the VendorLearning vertical is explained end-to-end with a clean per-responsibility disposition. No persistence decision was made or required.

> **A — BUSINESS MEMORY ARCHITECTURE READY FOR PERSISTENCE DESIGN.**

---

*Architecture v1 · PROPOSED. Implements Contract v1; Contract v1 governs on any tension. No code/schema/migration/API/worker; VendorLearning unmodified. Persistence Design is a separate stage pending owner approval.*
