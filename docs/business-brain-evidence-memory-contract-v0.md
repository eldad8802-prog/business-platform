# Dubiz — Evidence ↔ Business Memory Contract v0

> **Status: PROPOSED CONTRACT — NOT YET RATIFIED.**
> **Type:** contract (a boundary), not architecture, not implementation.
> **Follows the ratified decision:** *C — SPLIT REASONING FROM LEARNING* (Business Brain Architectural Reconciliation). Evidence/Reasoning and Learning/Business-Memory are two subsystems connected by a contract; this document locks **one** boundary.
> **Baseline:** `origin/main 88c69fe`. Firsthand-revalidated: C0/RIA not wired to runtime; VendorLearning is still a mutable authoritative row (`usageCount`,`confidence`,`@@unique([businessId,vendorName])`); owner corrections are captured as `ReviewEvent` via `correction-ledger.service.ts`; `decideCategory` reads VendorLearning learning-first.

---

## 1. Purpose
Lock the single boundary between the **Evidence/Reasoning Engine** and the **Business Memory Engine**: what may pass from Evidence into Memory, what Memory may derive/retain, and how Memory's knowledge returns to recommendations **without becoming truth, authority, or an autonomous action.**

## 2. Scope / Non-Goals
- **In scope:** the Evidence→Memory input contract, Business-Memory semantics, the owner-feedback loop, confidence/conflict/staleness *semantics*, the optional Identity/Reasoning couplings, and the Memory→Recommendation boundary.
- **NOT in scope (do not define here):** Prisma schema, tables, migrations, APIs, queues, cron, classes, repository interfaces, exact TypeScript types, a final confidence formula, RIA policy, new C1 operators, Belief/Judgment. `pseudo-shapes` below are illustrative only.

## 3. Definitions (the terms this contract binds)
- **Evidence** — a canonical fact that something was observed/happened/decided, with provenance. Authoritative, immutable, append-only. (C0 `CanonicalObservation`; owner decisions are also evidence.)
- **Evidence set** — the tenant-scoped, time-ordered collection of evidence items relevant to one memory subject.
- **Learned knowledge** — a business-specific statement *derived* from an evidence set by a versioned derivation policy (e.g. "for this business, vendor X → category Y"). **Not** raw evidence, **not** truth.
- **Confidence** — a *derived, explainable* measure of how well the current evidence set supports a piece of learned knowledge. **Not** truth, **not** authority.
- **Conflict** — an evidence set that supports more than one incompatible conclusion.
- **Freshness / Staleness** — how current the supporting evidence is relative to now.
- **Recommendation** — a suggestion to the owner built from evidence + learned knowledge (± reasoning). **Not** a decision, **not** an action.

## 4. Authority Model
`Raw Signal → Observation → Evidence → Learned Knowledge → Recommendation → Decision → Action` — each layer has a distinct authority; **authority never flows upward.**
- **Authoritative:** Evidence (facts) and **Owner Decisions**.
- **NOT authoritative:** inference, confidence, learned knowledge, recommendation, any materialized memory row.
- AI/OCR is not authority · provenance is not verdict · confidence is not truth · learned association is not fact · recommendation is not action · **owner correction becomes evidence, never a hidden hardcoded exception.**

## 5. Evidence → Memory Contract (what Evidence may supply)
Memory consumes **evidence items**, each carrying: `{ tenant(businessId), subjectKey, provenance, occurredAt, recordedAt, payload }`. Input categories:

| Input | Semantics | Authority | Provenance | Tenant | Version | Immutable | Optional |
|---|---|---|---|---|---|---|---|
| **Canonical Observation** | a canonical fact | authoritative fact | required | required | required | yes | no (the base input) |
| **Owner Decision / Correction** | owner accepted/rejected/corrected | **authoritative** | required (who/when/what) | required | required | yes (append-only) | no (the learning signal) |
| **Inferred Observation** (OCR/LLM) | a machine belief | **non-authoritative** (SELF_ASSERTED) | required (engine,runId) | required | required | yes | no |
| **Canonical Referent** (RIA) | "which world-thing" | resolution, not fact | required | required | required | — | **YES — cross-domain only** |
| **Reasoning/Detection result** (C1) | a structured readout (e.g. EQUAL) | derived input | required (operator+relata) | required | required | — | **YES — structured cases only** |

**Hard rule:** RIA and C1 are **NOT prerequisites** for Memory input. Simple learning MUST be possible from `{Canonical Observation + Owner Correction}` alone, keyed on a domain-local subject key.

## 6. Business Memory Semantics
**Business Memory is** the tenant-local layer that accumulates business-specific learned knowledge **derived** from evidence and owner outcomes, and exposes it (with confidence and state) to the Recommendation layer.

- **MAY consume:** evidence items (§5).
- **MAY derive:** learned-knowledge statements + confidence + state, per a **versioned derivation policy**.
- **MAY persist:** materialized knowledge **as a cache/index** of a derivation (never as the source of truth).
- **MUST retain/explain:** for every knowledge item, the evidence set + derivation-policy-version that produced it (explainability on demand).
- **MUST NOT treat as truth:** its own learned knowledge or confidence.
- **MUST NOT:** rewrite/delete evidence; create autonomous actions; store owner-invisible exceptions; hold cross-tenant knowledge; let a stored number override its own evidence.

Distinctions it must keep separate: *evidence* (fact) ≠ *evidence set* (the corpus) ≠ *learned knowledge* (derivation) ≠ *confidence* (derived measure) ≠ *conflict/staleness* (state of the set) ≠ *recommendation* (owner-facing output).

## 7. Derived Knowledge Rule (the load-bearing invariant)
> **INV-1 (RATIFY-CANDIDATE): Every business-specific learned-knowledge item MUST be reconstructable from its retained evidence set + the versioned derivation policy that produced it.**

- **Materialized memory is allowed** — but only as a **cache** of INV-1's derivation. It is *never* the source of truth.
- **Cache vs authority:** a stored knowledge row is a cache iff it can be dropped and rebuilt from evidence+policy with an identical result. If it cannot, it is illegitimate authority and violates INV-1.
- **Cache ↔ evidence conflict → evidence wins.** The cache is re-derived; the stale cache never overrides its evidence.
- **Derivation policy changes** → knowledge is **re-derivable** under the new policy version; historical knowledge stays reconstructable under the policy version that produced it (replay). Evidence is untouched.
- **Honest exception (OPEN):** external/irreversible side-effects already taken on a past recommendation are *themselves new evidence*; they are retained, not "un-derived." Full rebuildability applies to **knowledge**, not to the world. (See Open Questions.)

## 8. Owner Feedback Contract
> **INV-2: The owner creates evidence; the owner never edits memory directly.**

`recommendation → owner {accept | reject | correct | reverse | no-response} → new evidence (append-only) → memory re-derivation.`
- **accept** = corroborating evidence. **reject** = negative evidence. **correction** = a new owner-decision evidence item (does not erase prior ones). **reversal** = later evidence that supersedes earlier by recency, without deleting it. **conflicting corrections over time** = retained as-is → a **conflicted** evidence set (§9). **no-response** = **not** evidence; **silence ≠ approval** (INV-4).

## 9. Confidence / Conflict / Staleness
- **Confidence is** a derived, explainable function of the evidence set (e.g. corroboration count, recency, consistency); **it is NOT** truth, owner authority, or a free-standing stored fact. If stored, it is a **materialization** of the derivation, subject to §7. (No numeric formula chosen here.)
- **Conflict:** an evidence set supporting incompatible conclusions (e.g. 5× "vendor X → Office", then 2× "→ Inventory") is represented as **conflicted** — full history retained, **never** rewritten to pretend the new answer was always known.
- **Staleness:** derived from freshness (C0 `FreshnessBasis` already exists).
- **Knowledge states (semantics, not schema):** `current` · `stale` · `conflicted` · `insufficient-evidence` · `superseded`.

## 10. Optional Identity + Reasoning boundary
- **Identity (RIA) — REQUIRED / OPTIONAL / UNNECESSARY:**
  - *domain-local key* (e.g. `(businessId, normalizedVendorName)`) → RIA **UNNECESSARY**. Memory works without it.
  - *cross-domain* (same vendor via OCR + Supplier + WhatsApp + bank) → RIA **REQUIRED** to key knowledge on one canonical referent.
  - **Late-binding rule (semantic, not schema):** if knowledge first formed on a domain-local key later gains a canonical referent, the referent-keyed knowledge is **re-derived over the same retained evidence** and the domain-local key is recorded as an **alias/association** of the referent. **No evidence is rewritten; no history is lost.**
- **Reasoning (C1):** a reasoning/detection output is an **evidence-derived input** to Memory (§5), **not** learned knowledge by itself. C1 is **OPTIONAL** — required only for structured cases; it is never a mandatory dependency of Memory.

## 11. Memory → Recommendation Contract
> **INV-3: Memory ≠ Recommendation ≠ Decision ≠ Action.**

Memory exposes read-only knowledge: `{ likely value, known preference, recurring association, confidence, evidence summary/explanation, state(current/stale/conflicted/…) }`. The Recommendation layer turns that into a suggestion; the **Owner decides**; the decision returns as evidence (§8). Memory performs no business action.

## 12. VendorLearning — Retrofit Test (contract proof, NOT a migration plan)
**CURRENT (FACT):** on approve, `app/api/documents/[id]/approve/route.ts` does `prisma.vendorLearning.upsert(... confidence:{increment:0.02}, usageCount:{increment:1})`; `decideCategory` reads `vendorLearning.findUnique` **first** and returns its `category` with confidence bucketed by `usageCount`. Owner corrections are *also* written as `ReviewEvent` (evidence) — a **parallel, disconnected** path.

**CONTRACT-COMPLIANT CONCEPTUAL FORM:** owner approve/correct → append **owner-decision evidence** (the ReviewEvent already exists) → Business Memory **derives** `(business, vendor) → category` + confidence **from that evidence set** (policy-versioned, rebuildable) → optional cache → `decideCategory` reads the derived knowledge (with state/explanation).

**VIOLATIONS (of this contract):**
1. **INV-1** — `VendorLearning` is a mutable authoritative counter, **not derivable** from evidence (it can't be dropped and rebuilt identically; the `+0.02`/`+1` mutations are path-dependent).
2. **INV-2 / hidden exception** — the learned state is written **in a parallel path** to the evidence (ReviewEvent), so the association can drift from the evidence that supposedly justifies it — the exact "mysterious hardcoded exception" the architecture forbids.
3. **§9 confidence** — `confidence` (`0.8`, `+0.02`) is a stored free-standing number, not a derived/explainable function of evidence.
4. **§9 conflict** — an `upsert` on a single row **overwrites** the prior category; a corrected vendor **erases** the earlier association (no conflicted state, history rewritten).

**PRESERVED VALUE:** the *capability* (learning-first vendor→category lookup that lifts approval friction) is correct and wanted; the read-first placement in `decideCategory` is the right integration point; the `ReviewEvent` capture is already the right evidence.

## 13. Cross-Domain Test
Same vendor appears via **OCR invoice + Supplier entity + WhatsApp + bank transaction**. Under the contract: each source → Canonical Observation → **RIA resolves one canonical referent** (§10, now REQUIRED) → optional Detection (e.g. Equality of a normalized identifier) as evidence-derived input → Business Memory keys knowledge on the **referent** and derives it from the unified evidence set → recommendation → owner. The **same contract** serves both the simple (no RIA/C1) and cross-domain (RIA required, C1 optional) cases; the late-binding rule (§10) merges a previously domain-local vendor into the referent **without rewriting evidence.** No contract change was required to support both.

## 14. Invariants (candidates)
- **INV-1** Learned knowledge is reconstructable from retained evidence + versioned derivation policy.
- **INV-2** Owner decisions are evidence; the owner never edits memory directly. **Silence ≠ approval (INV-4).**
- **INV-3** Memory ≠ Recommendation ≠ Decision ≠ Action; memory creates no autonomous business action.
- **INV-5** Learned knowledge is not raw evidence and is not truth.
- **INV-6** Confidence is not truth and not authority; it is derived and explainable.
- **INV-7** Materialized memory is a cache, never the source of truth; on cache↔evidence conflict, evidence wins.
- **INV-8** Business Memory is tenant-local.
- **INV-9** Every recommendation-affecting memory item is explainable by its evidence.
- **INV-10** RIA is optional unless cross-domain identity resolution is required.
- **INV-11** Detection Grammar (C1) is optional unless structured reasoning is required.
- **INV-12** Evidence history is never rewritten merely because learned knowledge changed.

## 15. Explicit resolution of VendorLearning's ambiguity
**Q:** VendorLearning says `confidence=0.8`, but the `ReviewEvent`s behind it no longer support "vendor X → Office" — who wins?
**A (from INV-1 + INV-7, not a special case): the evidence wins.** The stored `0.8`/category is a **stale cache**; the authoritative answer is **re-derived from the current `ReviewEvent` evidence set** under the policy version. If that evidence set is now conflicted (recent corrections to "Inventory"), the knowledge state is **conflicted**, confidence reflects that, and the recommendation surfaces it — the old `0.8` never overrides its own evidence.

## 16. Open Questions
1. **Rebuildability vs irreversible side-effects** (§7): actions already taken on a past recommendation are new evidence, not "un-derivable" — is that framing sufficient, or is a bounded exception needed?
2. **Derivation-policy identity/versioning** — how a policy version is named/pinned so historical knowledge replays. (No schema here.)
3. **Confidence function shape** — deferred (not chosen).
4. **Evidence retention vs privacy/erasure** — retained evidence underpins rebuildability, but privacy/erasure may require pseudonymization (ties to RIA's still-OPEN erasure question). Unresolved.
5. **Global vs tenant knowledge** — `VendorLearning.isGlobal` exists; the contract asserts tenant-local — is any cross-tenant (platform-level) knowledge legitimate, and if so under what authority?
6. **Where Memory persists** — evidence-side (ledger) vs a memory-side cache — a schema decision deferred to a later stage.

---

*PROPOSED CONTRACT v0. Locks one boundary (Evidence ↔ Business Memory). Not ratified. Introduces no schema, API, migration, or code. Subject to owner review.*
