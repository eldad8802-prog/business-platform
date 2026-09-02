# Dubiz — Business Memory IMPL-2 · Pre-Implementation Decision v1

> **Status: PRE-IMPLEMENTATION DECISION — NOT SCHEMA, NOT CODE.** Read-only analysis selecting the single next step after `DerivationPolicy` + `DerivationPolicyVersion`. Implements `business-brain-evidence-memory-contract-v1.md` (RATIFIED) + `business-brain-memory-architecture-v1.md` + `business-brain-memory-persistence-design-v1.md`. Where any tension arises, **Contract v1 governs**.
> **Baseline:** `origin/main 6f3618e` (firsthand-revalidated, unchanged). **Production substrate:** `DerivationPolicy` + `DerivationPolicyVersion` applied 2026-08-17 (release-migrate run `31979044047`); empty, global, inert, unwired.
> **Type:** a decision (which step is next, and why *not* the others). No Prisma / SQL / migration / adapter code / Claim / runtime.

---

## 1. Current Baseline (firsthand)
- **Business Memory models in schema (exactly two):** `DerivationPolicy { id, name, createdAt, versions }` · `DerivationPolicyVersion { id, policyId, version, createdAt, FK→Policy onDelete:Restrict, @@unique([policyId,version]), @@index([policyId]) }`. **GLOBAL** (no businessId), immutable, identity-only uniqueness, no content/selector/current/latest. Inert (0 runtime consumers).
- **Production:** the two tables exist, empty/inert/global/unwired (deductive row-count 0).
- **Canonical evidence already in the repo:** `ReviewEvent` (id, documentId, businessId, occurredAt, reviewerUserId, approvedAs, vendorBelief/Final, directionBelief/Final, `verdicts` Json, `rawBelief`/`rawFinal` Json) — **append-only, tenant-scoped, scalar-only** (no Prisma relation by ledger design), indexed by `documentId` and `(businessId, occurredAt)`. Written at **approve**. This is the ratified **canonical owner-decision evidence** (Persistence Design §5/§15).
- **Engine-belief context:** `ExtractionSnapshot` (+ `SliceDecision`) — append-only, non-authoritative, joinable to ReviewEvent by `documentId`.
- **The learning primitive (untouched):** `VendorLearning { businessId, vendorName, category, usageCount, confidence, isGlobal, @@unique([businessId,vendorName]) }` — mutable counter; `decideCategory` reads it via `findUnique` (learning-first). **Not touched here.**
- **RIA:** `RiaCanonicalReferent`, `RiaPolicyLineage` — inert, tenant-scoped, RESTRICT, no uniqueness. Cross-domain identity authority (optional, INV-11).
- **Migration conventions observed:** additive-only; RESTRICT FK for canonical/history substrates (Cascade only for tenant-owned mutable data like VendorLearning); governed String slots not enums; recorded-only `createdAt`; no uniqueness on governed identity; heavy `///` intent comments; inert-before-wired.

**Revalidation:** no advance since `6f3618e` touches schema / migrations / business-memory / RIA / evidence. **No REVALIDATION-REQUIRED.**

---

## 2. Dependency Truth — what must exist *before* a Derived Claim
Starting from the Claim's logical shape (Architecture §5; Persistence Design §4 identity = `(subjectKey, policyVersion)`), not from the historical drawing `SubjectRef + EvidenceRef + PolicyVersion + Claim`:

| Claim dependency | Classification | Firsthand justification |
|---|---|---|
| **policyVersion pin** (INV-2) | **persistence-required — ALREADY EXISTS** | `DerivationPolicyVersion` is live; a Claim pins it by FK. This is *why* the policy substrate was slice 1. |
| **subject (domain-local)** | **inline value — NOT a table** | Architecture §10.A: `SubjectKey = domainLocal(businessId, normalizedVendorName)` — a string. No RIA, no SubjectRef table needed for vendor→category. |
| **subject (cross-domain referent)** | **can-be-deferred** | Only for RIA-spanning subjects (INV-11 optional). RIA referent already exists; a second identity table is forbidden. |
| **evidence set** | **already canonical (ReviewEvent) — read via adapter** | The authoritative evidence exists. What is missing is the *stable way Memory names/reads it* — a **code contract**, not a store. |
| **evidence-set reference / link** (INV-10) | **derived / rebuildable — depends on the adapter's identity** | Persistence Design §4 marks `Claim↔Evidence Link` derived/droppable; the *definition* of "the evidence set of a subject" is the adapter contract. |
| **proposition representation** | **OPEN — ontology, undecided** | §7 of this analysis. `category` (specific) vs `predicate+value` (generic) is an unmade semantic commitment. |
| **state** | **derived — cache-only, not a prerequisite** | Architecture §6; Persistence Design §7. |
| **confidence** | **deferred — no formula; cache-only** | Contract §9; Persistence Design §8. |

**Reading of the table:** exactly **one** dependency is both missing *and* a true prerequisite of a *coherent, explainable* Claim — the **stable evidence identity + reader** (INV-10). It is **code**, because the store (ReviewEvent) already exists. Subject is inline; policyVersion exists; state/confidence are cache/deferred; proposition is an OPEN that sits *inside* the Claim, not before it.

---

## 3. Candidate A — SubjectRef / Alias substrate
- Can a Claim hold its subject domain-locally? **Yes** — `(businessId, normalizedVendorName)` as an inline string (Architecture §10.A). A normalized vendor key **is sufficient for v1**.
- Is a persisted SubjectRef abstraction required now? **No.** It is required only for **RIA late-binding** (a domain-local key later gains a canonical referent → alias), which is **deferred** (INV-11 optional; no cross-domain consumer exists).
- SubjectRef **without** a Claim to key = an **empty substrate** (no coherent standalone meaning).
- Late binding to RIA does **not** need a persistence root up front — Architecture §10 late-binding derives a *new* referent-keyed projection over the **same evidence** and appends an alias *when* RIA resolves; nothing must pre-exist.
- **Red line:** a SubjectRef built now risks a **second identity authority** competing with RIA (owner constraint; RIA already owns cross-domain referents). 
- **Verdict on A: premature.** Building it now is over-engineering (an unused abstraction, wrong order, identity-authority risk).

## 4. Candidate B — Evidence Reference / Adapter
- Persistence Design §18 already ruled: **P1 executed *through* a P4 adapter seam** — reuse `ReviewEvent` as canonical evidence now, but have Memory read it **only through a stable Evidence-Reference/Adapter**, so the source can later become a unified log / C0 **without touching Memory**.
- Is it a **persistence slice**? **No.** The canonical evidence (`ReviewEvent`) **already exists and is conformant** (append-only, tenant-scoped). A new `EvidenceRef` **table** would be a **duplicate evidence store in disguise** — exactly the "invent a table to complete the diagram" anti-pattern. Persistence Design §4 marks the evidence *link* as **derived/rebuildable**, not a canonical store.
- Can a future Claim reference existing `ReviewEvent` rows through an adapter **without** a new reference table? **Yes** — the evidence set of a domain-local subject is deterministically "all `ReviewEvent`s for `(businessId, normalized vendorFinal)`, ordered by `occurredAt`"; the reference is **recomputable**, so it need not be stored canonically.
- Does a stable logical reference require a physical record? **No** — it requires a **stable identity contract** (which ids, what ordering, what tenant scope), which is **code**.
- **Verdict on B: this is the real next step — but as a CODE CONTRACT, explicitly NOT a persistence candidate.** It is the one true prerequisite of a coherent Claim (§2), and it must be a seam (P4) so the canonical source can move later.

## 5. Candidate C — Derived Claim
- Minimal domain-local shape would be `{ businessId, subjectKey(string), policyVersionId(FK), <proposition>, <state cache>, createdAt }`.
- Blockers:
  - **Proposition representation is OPEN** (§7). Baking `category` bakes **vendor semantics into the memory core**; going generic (`predicate+value`) **designs ontology prematurely**. Either is a semantic commitment the stage forbids.
  - **Explainability (INV-10) depends on B.** Without the evidence-identity contract, the Claim's `derivedFrom.evidenceSetRef` must either hard-wire to `ReviewEvent` physical ids (**breaks the P4 seam** — couples Memory to the physical source) or be undefined. So **even a domain-specific Claim depends on the adapter contract first.**
- **Inert does not neutralize the risk here.** An inert *Policy* table commits to nothing semantic (a name + a version label). An inert *Claim* table's **shape encodes the proposition ontology** — so "no writer" does not make a premature ontology safe. Table existence would still freeze a semantic decision.
- **Verdict on C: not ready.** Depends on B; blocked by an unresolved proposition representation. (A Claim table now would load a latent ontology — forbidden.)

---

## 6. Generic vs First-Use-Case-Specific
| Axis | Generic `predicate+value` Claim | Vendor→Category-specific Claim |
|---|---|---|
| semantic clarity | low now (no 2nd use-case to generalize from) | high (matches the one live use-case) |
| reuse | speculative | none yet |
| over-engineering risk | **high** (ontology before evidence) | medium (semantics leak into core) |
| future compat (customer/supplier/memory) | *claimed*, unproven | needs generalization later |
| Contract-v1 preservation | at risk (invites a proposition ontology) | preservable |
| migration cost | high to undo a wrong ontology | medium |
| time-to-first-real-memory | slow | faster |
| risk of baking vendor semantics into core | low | **high** |

**Reading:** there is **no shared second use-case** to justify generic yet, and both options force a decision the stage defers. This is another reason the Claim is not the next slice: choosing its representation *is* the deferred ontology work. **Prefer generic only if semantics are genuinely shared — they are not yet.**

## 7. Proposition Representation — the material OPEN
Options exist (`claimType+value` · typed proposition · domain payload · subject/predicate/object relation) but **none can be selected without proving what is required**, and proving that needs a second use-case beyond vendor→category. Per the stage rule: **because proposition representation is a material OPEN, the Claim is not ready.** Designing it now would be ontology-first.

## 8. Evidence-Link Minimum
- Hard rule: **No persisted Claim without reconstructable evidence linkage** (INV-10).
- For a domain-local subject the linkage is **reconstructable** ("all `ReviewEvent`s for the subject") → it need not be a canonical store — **but its definition is the adapter contract (B).**
- Therefore the evidence link does **not** require an `EvidenceRef` substrate first; it requires the **evidence-identity contract** first. This points at B, not at a new table.

## 9. Policy Dependency (already satisfied)
`DerivationPolicyVersion` exists; a future Claim will FK-pin it (INV-2), `onDelete: Restrict` already guarantees policy history is never cascade-deleted by a Claim. No selection/currentness column exists or will be added. **No further policy substrate is needed before the Claim** — policy is the *satisfied* prerequisite; the *unsatisfied* one is evidence identity.

## 10. Tenant Model
`ReviewEvent` carries `businessId`; the adapter (B) filters every read by tenant and makes **no cross-tenant evidence set representable**. A future Claim carries `businessId`; a Claim↔evidence relationship is same-tenant by construction. RIA referent + tenant is preserved (RIA rows are tenant-scoped). **No global learned knowledge** (INV-9).

## 11. Delete / 12. Immutability (per candidate)
| | Canonical (never cascade-dropped by a Claim) | Derived (droppable/rebuildable) |
|---|---|---|
| ReviewEvent (evidence) | **immutable/append-only, permanent** | — |
| DerivationPolicyVersion | **immutable, RESTRICT** | — |
| Subject alias (if ever) | append-only mapping | — |
| Derived Claim (future) | — | **droppable + rebuildable; no status machine** (rebuild suffices) |
The adapter (B) introduces **no** new delete/immutability surface (no table). This is another point in its favor: zero migration and zero lifecycle risk.

## 13. VendorLearning Walkthrough (untouched)
| Candidate | What it enables for vendor→category | Invariant it proves | Migration/backfill now? | Closer to a real read-path? |
|---|---|---|---|---|
| A SubjectRef | nothing (subject is already an inline vendor string) | none standalone | no | no |
| **B Adapter** | a stable, tenant-scoped read of the ReviewEvent evidence set for a vendor subject | INV-10 (explainable evidence identity), P4 seam | **no** | **yes — it is the Evidence Reader the Claim/`decideCategory` will consume** |
| C Claim | the output row | INV-1/2/8 — but needs B for INV-10 | risks premature backfill | not without B |
`VendorLearning` / `decideCategory` / `ReviewEvent` **remain untouched.**

## 14. Cross-Domain Walkthrough
Same supplier via ReviewEvent/document + Supplier entity + WhatsApp: **B keeps late-RIA-binding open** — the adapter can later serve a referent-keyed evidence set without changing its consumers (P4). Choosing A now would instead pre-commit a subject identity that competes with RIA. **No RIA activation required or performed.**

## 15. Candidate Matrix
| Criterion | A · SubjectRef | **B · Evidence Adapter (code)** | C · Derived Claim |
|---|---|---|---|
| prerequisite role | only for deferred cross-domain | **true prerequisite of a coherent Claim** | the output (downstream of B) |
| standalone coherence | empty (no Claim to key) | **coherent (defines evidence identity)** | needs proposition + B |
| semantic ambiguity | high (RIA-competing) | **low (maps to existing ReviewEvent)** | high (proposition OPEN) |
| invariant coverage | none alone | **INV-10/13 + P4 seam** | INV-1/2/8, but INV-10 needs B |
| future compatibility | 2nd-identity-authority risk | **enables unified-log/C0 swap untouched** | domain-specific ↔ generic bind |
| migration risk | adds an unused table | **zero (no persistence)** | shape freezes ontology |
| runtime-activation risk | low (inert) | **low (contract, no runtime)** | low, but shape commits semantics |
| over-engineering risk | **high** | **low** | medium-high |
| time-to-next-slice | slow (wrong order) | **fast (unblocks Claim)** | blocked |
| ability to remain inert | yes but pointless | **N/A (no table)** | yes but shape-committing |

## 16. Selected Next Step
**NEXT STEP = the Evidence-Reference / Adapter — as a CODE CONTRACT, not a persistence slice.**
- **Why now:** it is the single true prerequisite of a coherent, explainable Claim (§2/§8); policy is already satisfied, subject is inline, proposition is a Claim-internal OPEN.
- **Why before the others:** SubjectRef (A) is premature and RIA-competing; Claim (C) cannot be explainable (INV-10) or representation-decided without the evidence-identity contract first.
- **What it unlocks:** a stable, tenant-scoped Evidence Reader over `ReviewEvent` with a defined evidence-set identity → after which a **dedicated Claim pre-implementation** can tackle the *real* remaining blocker (proposition representation, generic-vs-specific) with the evidence side fixed.
- **What it deliberately does NOT unlock:** no Claim, no writer, no persistence, no VendorLearning change, no confidence, no policy selection, no RIA/C0/C1 activation, no backfill.

## 17. Conceptual Minimum of the Adapter Contract (definition only — NOT implemented)
A read-only code contract with exactly these five faces (Persistence Design §10/§11/§18):
1. **Logical interface:** `readOwnerDecisionEvidence(businessId, subjectKey) → ordered immutable evidence set` (read-only) + `evidenceSetIdentity(set) → stable identity` for a future Claim's `derivedFrom` (INV-10). No write path.
2. **Canonical-source mapping:** `subjectKey = domainLocal(businessId, normalizedVendorName)` → `ReviewEvent`s where `businessId` matches and `vendorFinal` normalizes to the key, ordered by `occurredAt`; `ExtractionSnapshot`/`SliceDecision` available as **non-authoritative** belief context (joined by `documentId`). This mapping is the **only** place aware of the physical source (P4 seam).
3. **Tenant guarantees:** every read filtered by `businessId`; **no cross-tenant evidence set representable**; evidence-set identity is tenant-local.
4. **Evidence identity:** the stable identity = the set of canonical `ReviewEvent` ids (+ append-only ordering key) returned — **referenced, never copied** (INV-10/13); defined here so the source can move later without touching Memory.
5. **Owner-decision semantics:** `ReviewEvent` is the **authoritative** owner-decision (accept/correct = `vendorFinal`/`verdicts`); silence ≠ evidence (only present rows count, INV-4); append-only — the reader performs **no** dedup/merge/precedence (conflict is a *derivation* concern, INV-8/13).

## 18. Forbidden Semantics (carried into the next task)
No new persistence · no Prisma/migration · no writer/runtime · no Claim · no confidence · no policy selection/current/latest · no VendorLearning read or write · no `ReviewEvent`/`ExtractionSnapshot`/`SliceDecision` schema change · no RIA/C0/C1 activation · no cross-tenant reference · no owner-edit of memory · no second identity authority.

## 19. Deferred Items (unchanged, still frozen)
Derived Claim substrate · proposition representation · generic-vs-domain-specific decision · SubjectRef/alias physical form · confidence formula · concrete erasure mechanism · unified evidence log · C0 persistence activation · VendorLearning migration/backfill + read switch · Recommendation integration · C1 expansion · RIA activation · policy selection · rebuild worker/triggering.

## 20. Exact Next-Task Scope (proposed, pending owner approval)
**Business Memory IMPL-2 (revised) — Evidence-Reference / Adapter *Code Contract* (contract-only):**
author a **read-only** interface + canonical-source mapping over `ReviewEvent` (with `ExtractionSnapshot` as belief context), fixing the five faces of §17 — as a code contract (e.g. a typed interface + mapping module under `lib/business-memory/`), **with NO Prisma, NO migration, NO writer, NO runtime consumer, NO Claim.** Then **re-gate**: with the evidence identity fixed, run a **dedicated Claim pre-implementation** whose sole focus is proposition representation + generic-vs-specific — the true remaining blocker.

## 21. STOP Conditions
READ-ONLY. This document changes **no** Prisma / migration / adapter / Claim / VendorLearning / branch / commit / PR / runtime. Implementation of the adapter contract is a **separate** step pending a separate owner approval.

---

## Verdict
The historical drawing (`SubjectRef → EvidenceRef → PolicyVersion → Claim`) does **not** survive dependency truth: policy already exists, subject is inline, evidence is already canonical, and the *link* is a code identity — not a store. SubjectRef is premature (RIA-competing); a Claim is blocked by an unresolved proposition ontology **and** depends on the evidence-identity contract first; an `EvidenceRef` table would be a duplicate store in disguise. The one true, minimal, coherent prerequisite is a **non-persistence Evidence-Reference/Adapter code contract**.

> **B — NON-PERSISTENCE CONTRACT MUST COME FIRST.**
> *(The next step is the Evidence-Reference/Adapter code contract, not a new persistence slice. No schema is forced to complete a diagram.)*

---

*IMPL-2 Pre-Implementation Decision v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1; Contract v1 governs. No code/schema/migration/adapter/Claim/runtime; VendorLearning / ReviewEvent / RIA / C0 / C1 unmodified and unactivated.*
