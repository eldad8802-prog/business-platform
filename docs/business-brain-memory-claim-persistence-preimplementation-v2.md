# Dubiz — Business Memory Derived Claim Persistence · Pre-Implementation Decision v2

> **Status: PRE-IMPLEMENTATION DECISION — NOT SCHEMA.** Read-only. Decides whether the merged `DerivedClaimResult` can be translated ~mechanically into a droppable materialized persistence projection, and if so its minimal coherent shape. Implements Contract v1 (RATIFIED) + Architecture v1 + Persistence Design v1 + Claim pre-impl v1 (verdict C). Where any tension arises, **Contract v1 governs**.
> **Baseline:** `origin/main 8a21d7c` (IMPL-3 Memory Deriver merged). Firsthand-revalidated, unchanged.
> **Type:** a decision. No Prisma / SQL / migration / code / branch / commit / PR.

---

## 1. Baseline (firsthand)
- **BM models on main (only two):** `DerivationPolicy` + `DerivationPolicyVersion` (GLOBAL, inert, prod-applied). No Claim model.
- **Evidence Adapter (IMPL-2, merged, inert):** store-agnostic `OwnerDecisionEvidenceSet` reader + stable `EvidenceSetIdentity`.
- **Memory Deriver (IMPL-3, merged, inert):** pure `DerivedClaimResult` — the OUTPUT this stage may materialize. **0 consumers.**
- No Claim persistence, no writer, no runtime consumer. **No REVALIDATION-REQUIRED.**

## 2. Source of truth (locked)
`DerivedClaimResult` (merged) is the **output contract of derivation**. Claim persistence, if added, is a **materialized projection of that output only** — it may introduce **no** semantics absent from the Deriver/Contract. Any field not justifiable from the output/contract does **not** enter v1.
```
DerivedClaimResult { subject, claimType:"vendor-category", policyVersionId, evidenceSetIdentity, state, candidates[] }
DerivedClaimCandidate { claimType, propositionValue, supportingRefs: EvidenceRef[] }
```
This is why the IMPL-3 blockers are gone: proposition (typed `claimType` + `propositionValue`), conflict (candidate-set), state (f(rowset)), evidence link (`supportingRefs`), subject (inline domain-local), policy pin (`policyVersionId`), confidence (absent) are all **already decided by merged code**. Persistence is now a translation, not a semantics invention.

## 3. Persisted unit — Result vs Candidate (central decision)
| | fidelity | rebuild | conflict | explain | uniq w/o precedence | simplicity | queryability | delete/rebuild | over-eng. |
|---|---|---|---|---|---|---|---|---|---|
| **A · Projection root + Candidates (+links)** | **5** | 5 | 5 | 5 | **5** | 4 | **5** | 5 | 4 |
| B · Candidates only (+links) | 4 | 5 | 5 | 5 | 5 | **5** | 3 | 5 | **5** |
| C · flat one-row-per-proposition | 3 | 4 | 4 | 4 | 4 | 4 | 3 | 4 | 3 |
| D · no persistence (derive-on-read) | 5 | 5 | 5 | 5 | n/a | 5 | 2 | 5 | 5 |
- **D** is correct *for correctness* but `decideCategory` is on the hot path (Persistence Design §6) → a rebuildable **cache** is warranted; D is the fallback, not the goal.
- **A (Projection root + Candidate + EvidenceLink)** is the faithful projection: the root **is** Architecture component [4] "Materialized Knowledge Projection", identity `(subject, policyVersion)` per Persistence Design §4; it holds shared context (fingerprint, policy pin) **once**, cascades cleanly, and reads as a unit for the future recommendation path. **Recommended.**
- **B** (candidates-only) is a viable simpler alternative (2 tables, shared context repeated per candidate). Noted; A preferred for normalization + queryability.
> **Recommendation: A — Projection + Candidate + EvidenceLink (M1).**

## 4. State persistence — revisited (do NOT persist it)
State is **derivable from the candidate rowset under a projection**: `1 candidate → supported`, `≥2 → conflicting`, `0 (no projection) → insufficient/withdrawn`. Persisting a `state` column is **redundant** and creates divergence risk. **No `state` column. No status machine.**

## 5. Insufficient / withdrawn persistence
- **Insufficient → NO row** (no projection). A projection exists **only** when ≥1 candidate; never an empty root "to remember" absence (owner §5).
- **Withdrawn → NO row after rebuild** (projection dropped when erasure collapses candidates). The withdrawn-vs-insufficient distinction lives with **erasure facts in the evidence tier**, not in the Claim (Contract §5/§14). No tombstone.

## 6. Conflict persistence
`Office(3 refs) + Inventory(1 ref)` → **one projection, two Candidate rows** (`Office`, `Inventory`), each with its own EvidenceLinks; **no winner / majority / preferred / order**. State = "conflicting" is read from the two-row count. Simplest unambiguous shape.

## 7. Proposition representation — grounded (String + discriminator, no JSON)
`claimType = "vendor-category"` (String discriminator) + `propositionValue = category` (String). **No JSON payload** (no genericity-for-its-own-sake). Typed semantics are carried by the discriminator; a future typed child model can specialize a kind later without touching v1. **String + discriminator suffices → prefer the simple.**

## 8. Subject persistence — inline (no SubjectRef table)
Materialize the `DomainLocalSubject` **inline** on the projection: `businessId + subjectDomain + subjectNormalizedKey`. No SubjectRef table. Tenant-local; no RIA-authority duplication; **late RIA binding stays possible via rebuild** (a future referent-keyed claimType derived over the same evidence — Architecture §10), never a rewrite. **Preferred — no blocker.**

## 9. Policy pinning
Projection → **FK `DerivationPolicyVersion` (onDelete: RESTRICT)** so policy history is never cascade-deleted by a Claim. Materializations under **different** policy versions **coexist** (identity includes `policyVersionId`). **No current/latest/default policy lookup.**

## 10. Evidence-set identity persistence
| E1 fingerprint only | E2 explicit links only | **E3 fingerprint + explicit links** | E4 derivation-run record |
|---|---|---|---|
- Contract requires **Claim → exact supporting evidence** (INV-10); a bare fingerprint cannot reach the refs → **E1 insufficient.**
- **E3 (recommended):** store the **full-set `evidenceSetFingerprint` once on the projection** (a staleness/rebuild aid — a fingerprint, **not** authority) **plus** explicit **per-candidate EvidenceLinks** (the exact supporting records, for explainability). E2 alone loses the cheap staleness check; E4 is heavier than v1 needs.

## 11. Supporting evidence links
A child record **`DerivedClaimEvidenceLink`**: `candidateId` + `businessId` (tenant echo) + `evidenceKind` (String, e.g. "review-event") + `evidenceRecordId` (Int). **Scalar reference — NO FK to `ReviewEvent`** (store-agnostic, matching the adapter seam and the correction-ledger's scalar-only design), so dropping a Claim can never affect evidence and no unified log is implied. **No raw payload copy.**

## 12. Materialization identity (no "one current")
- **Projection identity = `(businessId, subjectDomain, subjectNormalizedKey, claimType, policyVersionId)`** — Persistence Design §4. The **evidence set is NOT in identity** → re-derivation on evidence change **replaces the same projection** (it does not spawn stale roots). Different policy versions = different projections (legitimate coexistence). This is **not** "one current Claim" — it is one derivation-projection per pinned policy version. ✔ §12 test.
- **Candidate identity = `(projectionId, propositionValue)`.** **EvidenceLink identity = `(candidateId, evidenceKind, evidenceRecordId)`.** No precedence anywhere.

## 13. Materialization history — none
Contract: **evidence history is canonical; Claim history is not.** Rebuild = **transactional replace** (delete the projection's rows for `(subject, policyVersion)` + insert fresh). No `updatedAt`, no versioned Claim history, no double audit trail. `materializedAt` = last rebuild time (recorded-only).

## 14. Delete behavior
Derived → **droppable/rebuildable**. `Projection —(Cascade)→ Candidate —(Cascade)→ EvidenceLink` (dropping a projection cleans its children). **None cascades outward:** policy FK = **RESTRICT**; evidence links are **scalar** (no FK to ReviewEvent); no RIA relation. Deleting a Claim cannot harm Evidence, Policy, or RIA.

## 15. Confidence — absent
The Deriver output has no confidence; **v1 persists none.** No nullable placeholder (INV-7).

## 16. No writer yet
This is the **first substrate** decision. The implementation slice is **schema + migration + inert invariant test only** — Claim tables **empty/inert exactly like the Policy substrate**. **No** Memory materializer, Deriver→DB writer, rebuild worker, read path, or VendorLearning switch.

## 17. Generic vs vendor-category-specific — final
The **envelope is generic** (Projection/Candidate/EvidenceLink with a `claimType` **String discriminator** + String `propositionValue`) — reusable for future kinds — achieved **without JSON or a union schema**. This is the Hybrid direction realized cheaply. **Prefer the generic envelope.** (No ontology framework is introduced.)

## 18. Tenant enforcement (honest classification)
- **DB-enforceable now:** `businessId` on the projection and on each EvidenceLink; projection uniqueness is tenant-scoped. Same-tenant link↔projection consistency is enforceable via a **composite FK** `(candidateId, businessId) → Candidate(id, businessId)` (needs a composite unique on Candidate) — recommended **hardening** if cheap.
- **Deferred to the future writer:** that a link's `evidenceRecordId` truly belongs to the same tenant's evidence (the ref is scalar/store-agnostic, so this is a writer-time invariant, not a DB FK). **Classified, not claimed as a DB guarantee.**
- No `isGlobal`; no cross-tenant projection representable.

## 19. Migration characteristics
Additive **CREATE-only** (3 tables), **empty/inert**, **no backfill**, **no VendorLearning mutation**, RESTRICT to policy, Cascade among the three derived tables. VendorLearning transition remains a separate later slice.

## 20. Invariant matrix (all 18)
1 rebuildable→transactional replace from evidence+policy · 2 policy-versioned→FK policyVersionId in identity · 3 owner-decisions=evidence→unchanged (canonical tier) · 4 silence≠approval→enforced upstream in the Deriver · 5 five-entities-distinct→Claim is derived, separate tier · 6 knowledge≠truth→no truth/verified field · 7 confidence≠authority→**absent** · 8 materialized=disposable/evidence-wins→whole projection droppable, replace-on-conflict · 9 tenant-local→businessId on projection+link, no isGlobal · 10 explainable→per-candidate EvidenceLinks (E3) · 11 RIA-optional→inline subject, late-bind via rebuild · 12 C1-optional→no C1 field · 13 evidence-not-rewritten→scalar links, no FK/cascade to evidence · 14 erasure-invalidates→rebuild drops withdrawn projections · 15 irreversible-action=evidence→N/A (no action here) · 16 reasoning-provenance→N/A v1 (no C1 input) · 17 authority-one-directional→derived tier references, never rewrites · 18 no-autonomous-action→no action/recommendation field. **All 18 hold.**

## 21. Failure scenarios → persistence behaviour
| scenario | persistence does / allows |
|---|---|
| supported (Office) | one projection, one candidate |
| conflicting (Office/Inventory) | one projection, two candidates, no winner |
| no evidence | **no projection** (insufficient) |
| erased-only | projection dropped on rebuild (withdrawn = absence) |
| same-evidence replay | identical rows (idempotent replace) |
| new evidence set | same projection replaced (evidence set not in identity) |
| policy v1 vs v2 | **two coexisting projections** |
| cache deleted | rebuild from evidence+policy |
| partial materialization failure | **transactional replace** → all-or-nothing, no partial projection |
| cross-tenant link attempt | unrepresentable (businessId echo + composite FK) |

## 22. Persistence shapes compared
| | M1 · Projection+Candidate+Link | M2 · Candidate+Link | M3 · flat rows | M4 · derive-on-read |
|---|---|---|---|---|
| output fidelity | **5** | 4 | 3 | 5 |
| correctness | 5 | 5 | 4 | 5 |
| complexity | 4 | **5** | 4 | 5 |
| conflict support | 5 | 5 | 4 | 5 |
| rebuildability | 5 | 5 | 4 | 5 |
| explanation | 5 | 5 | 4 | 5 |
| queryability | **5** | 3 | 3 | 2 |
| future extensibility | **5** | 4 | 2 | 4 |
| migration risk | 4 | 5 | 4 | **5** |

## 23. Selected strategy
> **CLAIM PERSISTENCE STRATEGY = M1 — Projection root + Candidate + EvidenceLink** (state derived, not stored; E3 evidence identity; inline subject; policy-pinned; transactional-replace, no history).
> **NEXT IMPLEMENTATION SLICE = an additive, inert Claim-substrate: 3 CREATE-only tables + invariant test, NO writer / read-path / VendorLearning switch** — empty and inert exactly like the Policy substrate.

## 24. Conceptual schema minimum (NOT Prisma)
- **`DerivedClaimProjection`** — *derived, droppable.* Fields: `businessId`, `subjectDomain`, `subjectNormalizedKey`, `claimType`, `policyVersionId`, `evidenceSetFingerprint`, `materializedAt`. Relation: → `DerivationPolicyVersion` (**RESTRICT**); has many Candidates (**Cascade**). Unique: `(businessId, subjectDomain, subjectNormalizedKey, claimType, policyVersionId)`. Tenant: `businessId` required. Delete: droppable; never cascades to policy/evidence. Exists only when ≥1 candidate.
- **`DerivedClaimCandidate`** — *derived, droppable.* Fields: `projectionId`, `propositionValue`. Relation: → Projection (**Cascade**); has many EvidenceLinks (**Cascade**). Unique: `(projectionId, propositionValue)`. Tenant: via projection.
- **`DerivedClaimEvidenceLink`** — *derived, droppable.* Fields: `candidateId`, `businessId`, `evidenceKind`, `evidenceRecordId`. Relation: → Candidate (**Cascade**); **no FK to evidence** (scalar). Unique: `(candidateId, evidenceKind, evidenceRecordId)`. Optional hardening: composite FK `(candidateId, businessId)→Candidate(id, businessId)`.
- **Explicitly forbidden fields (all three):** `state/status/current/latest/active/preferred/selected/order/rank`, `confidence/score/weight`, `truth/verified`, `ownerApproved`, `recommendation/action/CTA/suggested*`, `isGlobal`, `updatedAt` (replace, don't mutate), arbitrary metadata `Json`, any RIA-authority field, any C1 field, any VendorLearning-compat field.

## 25. STOP-condition check (none triggered)
Building M1 requires **none** of: confidence formula · recommendation semantics · policy selection · RIA activation · SubjectRef table · unified evidence log · C1 integration · VendorLearning migration · ontology framework. → **not** a STOP.

## 26. Deferred items (unchanged)
Claim **writer/materializer** · rebuild worker/triggering · read-path/`decideCategory` switch · VendorLearning backfill · confidence formula · erasure runtime · recommendation layer · policy selection · unified evidence log · C0 persistence · RIA runtime/late-binding · C1 integration.

---

## Verdict
The merged Deriver fixed every semantic that blocked the Claim in v1. `DerivedClaimResult` translates **~mechanically** into a droppable materialized **Projection + Candidate + EvidenceLink**: state is derived (no column), conflict is a candidate rowset, evidence is linked by scalar reference (INV-10/13), subject is inline, policy is pinned (RESTRICT), confidence is absent, identity is precedence-free `(subject, policyVersion)`, and the whole projection is transactionally replaceable. All 18 invariants map; no STOP condition applies; the slice is an inert, additive, CREATE-only substrate with no writer.

> **A — CLAIM PERSISTENCE SUBSTRATE READY TO IMPLEMENT.**
> *Strategy M1 (Projection + Candidate + EvidenceLink). Next slice = inert additive schema + migration + invariant test, no writer. (M2 candidates-only is a viable simpler alternative if you prefer two tables.)*

---

*Claim Persistence Pre-Implementation Decision v2 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Claim pre-impl v1; Contract v1 governs. No code/schema/migration/Claim/writer/runtime; VendorLearning / ReviewEvent / Evidence Adapter / Memory Deriver / DerivationPolicy / RIA / C0 / C1 unmodified and unactivated.*
