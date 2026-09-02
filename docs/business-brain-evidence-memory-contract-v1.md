# Dubiz — Evidence ↔ Business Memory Contract v1

> **Status: RATIFIED — CANONICAL.**
> This is the normative authority for Business Memory going forward. `docs/business-brain-evidence-memory-contract-v0.md` (PROPOSED) and `docs/business-brain-evidence-memory-contract-ratification-v0.md` (adversarial audit → verdict B, amendments A1–A5) are **retained as decision history**; where they differ from v1, **v1 governs.**
> **Type:** a contract (a boundary). Not architecture, not schema, not implementation.
> **Basis:** the ratified decision *C — SPLIT REASONING FROM LEARNING*. Baseline `origin/main e7150c1`; the facts this contract rests on were firsthand-revalidated and unchanged.

---

## 1. Purpose
Define, unambiguously, the boundary and one-directional flow:
**Evidence → Business Memory → Recommendation → Owner Decision → Action → (new Evidence)** —
so that each is a **different kind of entity**, and authority **never flows backward** from Memory / inference / confidence into Evidence or Truth.

## 2. Scope / Non-Goals
- **Governs:** what may pass from Evidence/Reasoning into Business Memory; what Memory may derive/retain/expose; how learned knowledge returns to recommendations; and the invariants that keep the layers distinct.
- **Does NOT define (deferred — see §17):** Prisma models, table names, DB layout, event-store choice, `ReviewEvent`-vs-`SliceDecision` canonicalization, cache technology, a confidence formula, the concrete erasure mechanism, RIA erasure implementation, a Business-Memory API/writer, C1 expansion, SPEC-01..07/PART-A, Belief/Judgment. `pseudo-shapes` are illustrative only.

## 3. The five entity types
- **Evidence** — a canonical, immutable, append-only fact (something observed / inferred / decided), with provenance and version. *Authoritative.* (C0 `CanonicalObservation`; owner decisions are also evidence.)
- **Business Memory (learned knowledge)** — a tenant-local statement *derived* from an evidence set by a **versioned derivation policy**. *Not authoritative, not truth.*
- **Recommendation** — a suggestion to the owner built from evidence + memory (± reasoning), explainable by evidence. *Not a decision, not an action.*
- **Owner Decision** — the owner's accept / reject / correct / reverse. *Authoritative — and itself becomes Evidence.*
- **Action** — a change in the world/product taken after an owner decision. Its occurrence and result become **new Evidence**.

## 4. Authority Model (one-directional)
`Raw Signal → Observation → Evidence → Learned Knowledge → Recommendation → Decision → Action`.
- **Authoritative:** Evidence (facts) and **Owner Decisions**.
- **NOT authoritative:** inference, confidence, learned knowledge, recommendation, any materialized memory row.
- Authority never flows upward: **inference/confidence never rewrite evidence and never become truth.** AI/OCR is not authority; provenance is not verdict; confidence is not truth; learned association is not fact; recommendation is not action; owner correction is evidence, never a hidden hardcoded exception.

## 5. Canonical Evidence vs Materialized Memory
Two sides, with different authority and lifecycle:
- **Canonical side (authoritative, retained):** the append-only evidence — observations + owner decisions + required **provenance and version** information (incl. derivation-policy version, §6.A1; reasoning provenance, §6.A4).
- **Derived side (disposable, rebuildable):** Business Memory / learned knowledge / any materialized projection or cache.
> The derived side is **droppable and reconstructable** from the canonical side. It is never the source of truth. *(The physical stores for each side are a Persistence-Design decision — deferred, §17.)*

## 6. Evidence → Business Memory Contract
Memory consumes **evidence items** `{ tenant(businessId), subjectKey, provenance, version, occurredAt, recordedAt, payload }`. Input categories: **Canonical Observation** (authoritative fact), **Owner Decision/Correction** (authoritative learning signal), **Inferred Observation** (non-authoritative; carries engine/run provenance), **Canonical Referent** (optional — cross-domain only), **Reasoning/Detection result** (optional — structured cases only).
**Hard rule:** RIA and C1 are **not** prerequisites. Simple learning MUST be possible from `{Canonical Observation + Owner Correction}` on a domain-local subject key.

The five ratified amendments are normative here:

- **A1 · Derivation-policy versioning.** Every learned-knowledge item is reconstructable from `retained evidence + an explicitly versioned derivation policy`. Knowledge whose derivation policy is unknown is illegitimate. Changing the policy is **not** a mutation of evidence or of historical knowledge; it enables a new derivation/rebuild, while historical knowledge remains reconstructable under the policy version that produced it.
- **A2 · Erasure semantics.** Erasure is **not** a silent rewrite of history. It is represented as a **superseding / authoritative erasure fact**. Knowledge that depended on evidence no longer permitted to participate in derivation MUST re-derive to a state such as **withdrawn / insufficient-evidence**, and MUST NOT survive as authority. *(Mechanism deferred; ties to RIA's OPEN erasure question.)*
- **A3 · Irreversible side-effects.** Rebuildability is of **knowledge state**, never of the world. If a recommendation/decision/action produced an irreversible side-effect, **the action and its result become new Evidence**; Memory does not attempt to "restore the world" by rebuilding.
- **A4 · Reasoning provenance.** C1/reasoning/inference outputs used in a derivation are **version-pinned**. A changed reasoning result is a **new input**, never a mutation of a historical input. Non-deterministic reasoning carries **run identity/provenance** (per C0 `InferenceSubstrate`) so the source run is explainable. C1 stays **optional** — never a dependency of Business Memory.
- **A5 · Tenant locality.** Knowledge derived from a tenant's evidence is **tenant-local only** and MUST NOT be promoted to global (`isGlobal` or any equivalent). Platform/global defaults, if ever introduced, are **separate static/versioned rules** — never learned knowledge accumulated across businesses. The contract explicitly forbids "learning from all customers" disguised as confidence/statistics.

## 7. Business Memory Semantics
- **MAY consume** evidence items (§6). **MAY derive** knowledge + confidence + state via a versioned policy. **MAY persist** a materialization **as a rebuildable cache** (§5).
- **MUST retain/explain** for each item: the evidence set + derivation-policy version that produced it.
- **MUST NOT** treat its own knowledge/confidence as truth; rewrite/delete evidence; hold owner-invisible exceptions; hold cross-tenant knowledge; let a stored value override its own evidence.
- **Knowledge states (semantics, not schema):** `current` · `stale` · `conflicted` · `insufficient-evidence` · `withdrawn` · `superseded`.

## 8. Owner Feedback
The owner **creates evidence; never edits memory directly.**
`recommendation → owner {accept | reject | correct | reverse | no-response} → new evidence (append-only) → memory re-derivation.`
accept = corroborating evidence · reject = negative evidence · correction = a new owner-decision item (prior items retained) · reversal = later evidence superseding earlier by recency (earlier retained) · **conflicting corrections over time → a `conflicted` evidence set** · **no-response is not evidence — silence is not approval.**

## 9. Confidence / Conflict / Staleness
- **Confidence is** a derived, explainable function of the evidence set; **it is NOT** truth or authority. If stored, it is a materialization subject to §5. *(No formula chosen — deferred.)*
- **Conflict:** an evidence set supporting incompatible conclusions is represented as `conflicted` — full history retained, never rewritten to pretend the new answer was always known.
- **Staleness:** derived from freshness (C0 `FreshnessBasis`).

## 10. Memory → Recommendation
> **Memory ≠ Recommendation ≠ Decision ≠ Action.**
Memory exposes read-only knowledge `{ likely value, known preference, recurring association, confidence, evidence explanation, state }`. The Recommendation layer suggests; the **Owner decides**; the decision returns as evidence. Memory performs no business action.

---

## 11. Canonical Invariants (normative — v1)

1. **Rebuildable knowledge.** Every learned-knowledge item is reconstructable from retained evidence + its versioned derivation policy. *(A1)*
2. **Derivation policy is versioned.** No knowledge exists whose derivation-policy version is unknown. *(A1)*
3. **Owner decisions are evidence.** Accept/reject/correct/reverse are append-only evidence; the owner never edits memory directly.
4. **Silence is not approval.** Absence of an owner action is not evidence.
5. **Five entities stay distinct.** Evidence ≠ Knowledge ≠ Recommendation ≠ Decision ≠ Action.
6. **Knowledge is not truth**, and is not raw evidence.
7. **Confidence is not authority** and not truth; it is derived and explainable.
8. **Materialized memory is disposable/rebuildable** state, never the source of authority; **on any conflict, evidence wins** and the materialization is re-derived.
9. **Tenant-derived knowledge never crosses tenants**; it is never marked global; cross-business statistical accumulation is forbidden. *(A5)*
10. **Every derived conclusion is explainable through provenance** (its evidence set + policy version).
11. **RIA is optional** — required only when cross-domain identity resolution is needed; simple learning uses a domain-local key.
12. **C1/Detection Grammar is optional** — required only for structured reasoning; never a Memory dependency.
13. **Evidence history is never silently rewritten** because learned knowledge changed. *(append-only)*
14. **Erasure invalidates dependent derivations.** Erasure is a superseding/authoritative fact; knowledge depending on erased evidence re-derives to withdrawn/insufficient and never survives as authority. *(A2)*
15. **Irreversible actions become evidence.** Rebuildability is of knowledge, not the world; a side-effect's occurrence and result are appended as evidence. *(A3)*
16. **Reasoning inputs/runs retain provenance.** Reasoning/inference outputs used in derivation are version-pinned; a changed result is a new input, non-deterministic runs carry run identity. *(A4)*
17. **Authority is one-directional.** Inference/confidence/knowledge never rewrite evidence and never become truth.
18. **Memory creates no autonomous business action.**

## 12. VendorLearning — Retrofit Verdict (proof, not architecture)
**Conceptually preserved (the value):** the vendor→category learning use-case; the learning-first recommendation integration point (read in `decideCategory`); owner correction captured as useful evidence (`ReviewEvent`, append-only — already conformant on the evidence side).
**Cannot remain as a source of authority (violates v1):** the **mutable counter** (`usageCount`/`confidence` increments — INV-1/8); the **arbitrary stored confidence** (`0.8`/`+0.02` — INV-7); the **history-rewriting `upsert`** that overwrites a prior category (INV-13); the **parallel hidden learning path** disconnected from the evidence (INV-10); `isGlobal` for tenant-derived learning (INV-9).
*(VendorLearning is not modified here — it is the retrofit proof that v1 explains a real use-case and pinpoints exactly what must change.)*

## 13. Re-run of the 12 Ratification Scenarios under v1

| # | Scenario | Under v1 | Verdict |
|---|---|---|---|
| 1 | consistent correction ×N | rederive over append-only evidence; confidence rises | **HOLD** |
| 2 | conflicting decisions over time | append-only retained → `conflicted` state; no rewrite | **HOLD** |
| 3 | new evidence contradicts materialized memory | INV-8: evidence wins; re-derive | **HOLD** |
| 4 | derivation policy v1→v2 rebuild | INV-1/2: policy versioned → replay old, rebuild new | **HOLD** |
| 5 | evidence erased (privacy) | INV-14: erasure = superseding fact; knowledge withdraws | **HOLD** |
| 6 | irreversible world action from old recommendation | INV-15: action becomes evidence; no world-rebuild | **HOLD** |
| 7 | domain-local knowledge later gains RIA referent | §6/INV-11 late-binding: rederive over same evidence, alias, no rewrite | **HOLD** |
| 8 | C1 output wrong/changes after replay | INV-16: version-pinned input; changed result = new input; run identity | **HOLD** |
| 9 | same pattern at two tenants | INV-9: tenant-local; no isGlobal; no cross-business accumulation | **HOLD** |
| 10 | no owner correction | INV-4: silence ≠ approval; evidence only on explicit owner action | **HOLD** |
| 11 | materialized cache lost | INV-8: rebuild from append-only evidence (confirmed sufficient firsthand) | **HOLD** |
| 12 | VendorLearning retrofit | §12: use-case explained; violations pinpointed; value preserved | **HOLD** |

> **12/12 HOLD · 0 NEEDS-REFINEMENT · 0 FAIL.** The two prior NEEDS-REFINEMENT verdicts (INV-1, INV-8-legacy) are closed by amendments A1 and A5, now normative.

## 14. Deferred (explicitly NOT resolved in v1; require later stages)
confidence formula · Business-Memory Prisma/schema · persistence/store selection · `ReviewEvent`-vs-`SliceDecision` canonicalization · concrete erasure mechanism · RIA erasure implementation · Business-Memory API/writer · C1 expansion · SPEC-01..07/PART-A · Belief/Judgment ontology. *(None was required for v1 to be coherent.)*

## 15. Ratification
All 12 scenarios HOLD; all 18 invariants are normative and internally consistent; the canonical↔derived boundary is defined; the VendorLearning retrofit and cross-domain tests pass without changing the contract. **v1 is RATIFIED — CANONICAL** and is the normative authority for the next stage (Business Memory Architecture / Persistence Design), which is a **separate** stage pending owner approval.

---

*Contract v1 · RATIFIED — CANONICAL. Supersedes v0/ratification-v0 where they differ (they remain as history). No code/schema/migration/API/runtime change; no implementation. VendorLearning unmodified.*
