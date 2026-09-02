# Evidence ↔ Business Memory Contract — Ratification Audit (v0)

> **Type:** adversarial ratification audit of `docs/business-brain-evidence-memory-contract-v0.md`. Goal: **refute** the contract before adopting it. READ-ONLY / DOCUMENT-ONLY.
> **Does not modify v0** (decision history preserved). Records the audit result + required amendments (A1–A5) that must enter before the contract becomes normative.
> **Baseline:** `origin/main 88c69fe`.

## Sources inspected firsthand
`docs/business-brain-evidence-memory-contract-v0.md` · `prisma/schema.prisma` (`ReviewEvent`, `SliceDecision`, `ExtractionSnapshot`, `VendorLearning`) · `lib/services/documents/ledger/correction-ledger.service.ts` · `lib/services/documents/category-decision.service.ts` · `app/api/documents/[id]/approve/route.ts` · `lib/services/documents/vendor-learning.service.ts` · `lib/business-brain/observation.types.ts` · `lib/detection-grammar/equality/equality.types.ts` · `lib/referent-identity/cot-to-binding.ts`.

## Key firsthand facts that decide the audit
1. **Owner-correction evidence is append-only and rebuild-sufficient (FACT).** `correction-ledger.service.ts:12` — *"Append-only: only `create` is used; rows are never updated or deleted."* `ReviewEvent` retains `occurredAt`, `businessId`, `vendorBelief/vendorFinal`, `verdicts` (per-field belief/final incl. category), `rawBelief/rawFinal` (lossless). `SliceDecision` retains `category.classified` per document with `producedBy`/`provenance`. → **vendor→category is reconstructable from retained append-only evidence.** INV-1 is *achievable*, not fictional.
2. **The evidence layer never rewrites history (FACT).** Create-only ledger → INV-12 holds at the evidence layer. The `VendorLearning.upsert` overwrite is the **cache** violating the contract, exactly as v0 §12 diagnosed — not the evidence.
3. **`isGlobal` is a latent hole, not an exercised leak (FACT).** Both write sites (`approve/route.ts:224`, `vendor-learning.service.ts:35`) set `isGlobal:false`. No tenant-learned row is global today; the schema field is an open door that must be shut normatively.

---

## 12 Scenarios (adversarial)

| # | Scenario | Result under the contract | Verdict |
|---|---|---|---|
| 1 | Same conclusion corrected consistently ×N | Rederive over N append-only ReviewEvents; confidence rises with corroboration | **HOLD** |
| 2 | Conflicting owner decisions over time (5× Office, then 2× Inventory) | All retained append-only → rederive → **conflicted** state; history not rewritten. *(Current VendorLearning `upsert` would overwrite — the cache violation v0 §12 flags; the evidence survives, so the contract's rederive is possible.)* | **HOLD** (evidence) |
| 3 | New evidence contradicts materialized memory | INV-7: evidence wins; cache re-derived | **HOLD** |
| 4 | Derivation policy v1→v2 rebuild | Requires a **pinned derivation-policy version** to replay old knowledge; v0 **defers** this (OQ2) → INV-1 not operationally guaranteed | **NEEDS A1** |
| 5 | Evidence erased/pseudonymized (privacy/erasure) | INV-1 depends on retained evidence; erasure breaks rebuild unless erasure is itself modeled as evidence and knowledge withdraws | **NEEDS A2** |
| 6 | Irreversible world action followed an old recommendation | The side-effect is new evidence — but the contract doesn't require capturing world actions as evidence | **NEEDS A3** |
| 7 | Domain-local knowledge later gains a cross-domain RIA referent | §10 late-binding: rederive over same evidence, record alias, no rewrite | **HOLD** |
| 8 | C1 reasoning output wrong / changes after replay | Reasoning is an **evidence-derived input**, not knowledge; must be version-pinned so a changed result is a *new* input and old knowledge replays; non-deterministic reasoning needs run-identity | **NEEDS A4** |
| 9 | Same pattern at two tenants | INV-8 tenant-local; `isGlobal:false` today, but the field permits cross-tenant authority | **NEEDS A5** |
| 10 | No owner correction at all | Evidence is written only on an explicit owner action (approve/correct); an unreviewed document writes nothing → silence is not evidence | **HOLD** |
| 11 | Materialized cache fully lost | Rebuild from append-only `ReviewEvent` (+`SliceDecision`) — **confirmed sufficient firsthand** | **HOLD** |
| 12 | VendorLearning retrofit under the contract | v0 §12 correctly identifies 4 violations (mutable counter, parallel path, stored confidence, overwrite) + preserved value; re-confirmed firsthand | **HOLD** (contract explains it) |

**No scenario produced an architectural FAILURE.** Five produced *defined* refinements (A1–A5).

---

## INV-1..12 Matrix

| INV | Statement (short) | Verdict | Evidence / reasoning |
|---|---|---|---|
| **INV-1** | knowledge reconstructable from evidence + versioned policy | **NEEDS REFINEMENT** | Rebuild-sufficient evidence exists (ReviewEvent append-only) — but policy-versioning (A1) + erasure-as-evidence (A2) must be normative for INV-1 to be operationally true |
| **INV-2** | owner decisions are evidence; no direct memory edit | **HOLD** | ReviewEvent append-only captures accept/reject/correct |
| **INV-3** | Memory ≠ Recommendation ≠ Decision ≠ Action | **HOLD** | BusinessBot schema comments already enforce "never changes anything"; no autonomous action path |
| **INV-4** | silence ≠ approval | **HOLD** | evidence only on explicit owner action; unreviewed = no evidence |
| **INV-5** | knowledge is not raw evidence, not truth | **HOLD** | derivation is distinct from the evidence it reads |
| **INV-6** | confidence is not truth/authority; derived, explainable | **HOLD** (principle) | current `VendorLearning.confidence` violates it → the retrofit fix, not a contract defect |
| **INV-7** | materialized = cache; evidence wins on conflict | **HOLD** | rebuild-from-evidence confirmed (scenario 11) |
| **INV-8** | Business Memory is tenant-local | **NEEDS REFINEMENT** | holds today (`isGlobal:false`) but the field permits a leak → A5 closes it |
| **INV-9** | recommendation-affecting item explainable by evidence | **HOLD** | ReviewEvent/SliceDecision retain provenance + belief/final |
| **INV-10** | RIA optional unless cross-domain | **HOLD** | simple case keyed on `(businessId, normalizedVendorName)` — no RIA |
| **INV-11** | C1 optional unless structured reasoning | **HOLD** (with A4) | reasoning is optional input; A4 pins its replay identity |
| **INV-12** | evidence history never rewritten for knowledge change | **HOLD** | correction-ledger create-only |

**8 HOLD · 2 NEEDS REFINEMENT (INV-1, INV-8) · INV-11 HOLD-pending-A4 · 0 FAILS.**

---

## Required Amendments (must enter before ratification)

- **A1 — Derivation-policy versioning is NORMATIVE, not deferred.** Every derived knowledge item pins the identity/version of the derivation policy that produced it, so it replays under that version and rebuilds under a new one. (Promotes OQ2 from OPEN to normative; no formula, no schema.)
- **A2 — Erasure is modeled as superseding evidence.** Privacy/erasure appends a superseding "erased/withdrawn" evidence event; knowledge derived from erased evidence re-derives to *withdrawn / insufficient*, and **never silently survives as authority**. (Resolves the rebuildability↔privacy tension at the contract level; the mechanism ties to RIA's still-OPEN erasure question and stays deferred.)
- **A3 — Irreversible actions are captured as evidence.** An action taken on a recommendation is appended as evidence (append-only). Rebuildability applies to **knowledge**, not to the world; the world's side-effects are retained facts, not re-derivable state.
- **A4 — Reasoning/inference inputs are version-pinned.** A C1/inference result consumed by Memory carries its operator/engine version (and, if non-deterministic, a run identity, per C0 `InferenceSubstrate`); a changed reasoning result is a **new** evidence-derived input, never a mutation of a prior one.
- **A5 — Tenant-derived knowledge is strictly tenant-local.** Learned knowledge derived from one tenant's evidence MUST be tenant-local and MUST NOT be marked global. Any platform-level default is a **separate static-rules category** (like `CATEGORY_RULES`), never business memory, and is never fed by one tenant's corrections. (Closes the `isGlobal` hole.)

These five are **defined and bounded** — they strengthen the boundary; none refute the split-of-engines thesis.

## OPEN Questions — resolutions
1. **rebuildability vs irreversible side-effects** → **RESOLVED** by A3 (side-effects = evidence; rebuildability is of knowledge, not the world).
2. **derivation-policy versioning** → **RESOLVED** by A1 (normative).
3. **evidence retention vs privacy/erasure** → **RESOLVED in principle** by A2 (erasure = superseding evidence; knowledge withdraws). Mechanism deferred (RIA erasure OPEN).
4. **tenant-local vs isGlobal** → **RESOLVED** by A5 (tenant-local; global = separate static rules).
5. **canonical vs materialized persistence** → **RESOLVED in principle:** canonical persistence = the append-only evidence ledger; materialized memory = a droppable cache. *Which* physical store hosts the cache is a schema decision, **deferred** (non-blocking).
6. **confidence formula** → **remains deferred** (the contract is possible without it; confidence stays derived/explainable). **Not decided.**

## Separation & authority-flow check
- **Evidence ≠ Knowledge/Memory ≠ Recommendation ≠ Owner Decision ≠ Action** — preserved (INV-3/5/7; the only current blur, VendorLearning's mutable counter, is the retrofit target, not a contract defect).
- **Authority is one-directional** — inference/confidence never rewrite evidence (INV-12, correction-ledger create-only) and never become truth (INV-5/6). Confirmed firsthand.

## Unresolved risks
- **R1:** A2's erasure mechanism is genuinely coupled to RIA's OPEN privacy/erasure question — contract-level rule is settled, implementation mechanism is not (accepted deferral).
- **R2:** rebuilding vendor→category currently requires parsing `ReviewEvent.verdicts` Json / `SliceDecision` rows (category is not a top-level ReviewEvent column). Rebuild is *possible* but not *ergonomic* — a note for the eventual (deferred) schema stage, not a contract failure.
- **R3:** two parallel evidence-ish stores exist (`ReviewEvent` and `SliceDecision`/`ExtractionSnapshot`); which is the canonical evidence source for Memory is a later decision (OQ5, deferred).

---

## Readiness Verdict

> **B — RATIFY WITH REQUIRED AMENDMENTS.**

The thesis holds: Evidence/Reasoning and Learning/Memory are correctly split; memory-as-derived-from-evidence is **achievable from the existing append-only ledger** (confirmed firsthand); 12 invariants are 8 HOLD / 2 NEEDS-REFINEMENT / 0 FAILS; the VendorLearning retrofit and cross-domain tests both pass without changing the contract. It is **not** ratifiable as-is (A) because INV-1 and INV-8 are not operationally guaranteed until A1–A5 enter; it is **not** DO-NOT-RATIFY (C) because no architectural failure was found and every gap has a defined amendment.

**Becomes normative on ratification:** INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-9, INV-10, INV-12, plus INV-1/INV-8/INV-11 **as amended by A1–A5**.
**May remain deferred:** confidence formula (OQ6); the physical persistence/schema choice (OQ5/R3); the concrete erasure mechanism (A2/R1, tied to RIA); rebuild ergonomics (R2).

## Exact Next Step (proposed — not executed)
**Fold amendments A1–A5 into a ratified `Evidence ↔ Business Memory Contract v1`** (a small revision of v0 that promotes A1–A5 to normative invariants and marks OQ6/OQ5/erasure-mechanism as explicitly deferred), then **STOP** for owner ratification of v1 — *before* any schema, VendorLearning retrofit, or Business-Memory implementation.
- **Why now:** the boundary is one edit away from adoptable; A1–A5 are defined, so v1 is a mechanical consolidation, not new design.
- **What it resolves:** makes INV-1/INV-8 operationally true and removes the two NEEDS-REFINEMENT verdicts.
- **What proves success:** v1 re-passes all 12 scenarios with the two refinements closed and 0 NEEDS-REFINEMENT.
- **What must remain frozen:** ❌ schema/Prisma/migration · ❌ VendorLearning retrofit · ❌ Business-Memory implementation · ❌ C0/C1/RIA extension or activation · ❌ confidence formula · ❌ SPEC-01..07 / PART A / Belief-Judgment.

---

*Ratification audit v0. Does not modify contract v0. No code/schema/migration/API changes. Proposes contract v1 (amendments A1–A5) for owner ratification. Not itself ratified.*
