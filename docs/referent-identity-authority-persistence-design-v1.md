# RIA-1 · Production Persistence Design v1

**Stage:** RIA-PERSIST-1 · **Status:** Accepted Persistence Design · **Version:** v1
**Verdict:** **A — PERSISTENCE DESIGN READY FOR IMPLEMENTATION SUBSTRATE**
**Semantic authority:** `docs/referent-identity-authority-v1.md` (RIA-1 §0–§10).
**Architecture authority:** `docs/referent-identity-authority-runtime-architecture-v1.md` (Runtime Architecture v1).
**This document:** defines **logical persistence representation requirements / design only**. It is **not** semantic authority. **No schema, migration, or code has been implemented by this artifact. All OPENs remain OPEN.**

> **Authority hierarchy:** Governance (§0–§10) → Runtime Architecture → **Persistence Design (this)** → Existing Implementation. Existing `schema.prisma`/Party is evidence/precedent, never semantic authority.

**Tag discipline** — every material statement is tagged:
- **[RATIFIED]** — mandated by RIA-1 §0–§10.
- **[ARCH]** — from Runtime Architecture v1.
- **[REPO-FACT]** — found firsthand in the repository (file:path).
- **[DESIGN-CHOICE]** — a persistence design decision; **not** governance law; may be revised in implementation.
- **[OPEN]** — deferred; this document must **not** resolve it.

---

## Critical Persistence Locks (must hold in any implementation)
- Canonical Referent = **opaque, tenant-scoped identity anchor, not a truth container**. **[RATIFIED §4]**
- **Duplicate Canonical Referents remain legal; no DB uniqueness on real-world identifiers.** **[RATIFIED §4/§8 PA25]**
- **Source Referent Binding ≠ SAME authority.** **[RATIFIED §4]**
- **Evidence ≠ Grounds ≠ Authorized Basis ≠ Assertion** (four historically-distinct layers). **[RATIFIED §2/§8]**
- **Authorized Basis immutable; Identity Assertion immutable + append-only.** **[RATIFIED §3/§8]**
- Relation is only **{SAME, DISTINCT}**; **UNRESOLVED is not forced into an Assertion**; **CONFLICT is derived state-health, not a stored relation.** **[RATIFIED §1/§7]**
- **Correction/supersession is append-only** (no rewrite); **successor ≠ precedence.** **[RATIFIED §3/§10 RP16]**
- **Policy Version immutable; latest/newest row is never semantic selection.** **[RATIFIED §10]**
- **CII is derived; reconciliation materialization is non-authoritative.** **[RATIFIED §7]**
- **Every authoritative RIA fact is tenant-bound; authoritative history must not be cascade-deleted.** **[RATIFIED §0/§8]**
- **Idempotency uniqueness ≠ identity authority.** **[RATIFIED §8 PA25]**

---

## 1 · Executive Verdict
**A — PERSISTENCE DESIGN READY FOR IMPLEMENTATION SUBSTRATE.** A complete logical persistence contract for an **additive** RIA substrate exists; **no semantic blocker; no OPEN forced closed.** Existing-schema collisions (Party `onDelete: Cascade`; the claim-ledger `confidence/status/precedence` semantics; missing Supplier taxId/SUPPLIER role) are **designed around by additivity** and are **later-stage** (migration/rollout) concerns, not blockers to starting the substrate. **[ARCH]**

## 2 · Repository Baseline
`origin/main = 6138420` (unchanged since RIA-ARCH-1). Both canonical RIA docs present; **no RIA/Party/Customer/schema/C0 path changed since `6138420`**; worktree clean. No architecture revalidation required. **[REPO-FACT]**

## 3 · Canonical Source Hierarchy
Governance §0–§10 → Runtime Architecture v1 → **Persistence Design (this)** → Existing Implementation. Existing schema is precedent/evidence only. **[ARCH]**

## 4 · Contract → Persistence Requirement Matrix (abridged)
| Concept | Source | Persistence obligation | Authoritative? | Derived/Cache? | OPEN |
|---|---|---|---|---|---|
| Canonical Referent | §4 | opaque immutable id, tenant, non-reused, no truth-attrs, duplicates legal | yes | no | — |
| Source Referent Binding | §4/§8 | append-only, provenance to C0/source + authority input; no resolution | yes (provenance) | no | — |
| Evidence reference | §2/§9 | reference + provenance; value may live outside RIA | ref | no | privacy |
| Grounds | §2/§5 | captured in basis provenance | via basis | no | — |
| Authorized Basis | §2/§8 | immutable; refs PolicyVersion + Question + EvaluationTime + grounds | yes | no | — |
| Identity Assertion | §3 | immutable append-only; refs Basis + 2 endpoints + relation + recorded/effective | yes | no | — |
| SAME/DISTINCT | §1 | relation on Assertion | yes | no | — |
| UNRESOLVED | §1/§2 | not necessarily an assertion | — | eval-record | No-Auth persistence |
| CONFLICT | §1/§7 | derived state-health | no | derived | exit adjudication |
| Policy Lineage | §10 RP1 | stable governed identity | governed-config | no | — |
| Policy Version | §10 RP2 | immutable snapshot; refs lineage | governed-config | no | — |
| Policy Selection | §10 RP10/RP15 | reproducible governed decision | yes (eval-record) | no | RP15 artifact |
| Eval Context/Question/Evaluation | §8 | pinned inputs + EvaluationTime | provenance | eval-record | — |
| recorded/effective/EvaluationTime | §6 | explicit; no default | yes | no | temporal default |
| correction/supersession | §3/§10 RP16 | append-only; no rewrite; successor≠precedence | yes | no | — |
| policy retirement | §10 RP16 | append-only; future selection only | governed-config | no | future/backdated |
| CII | §7 | derived | no | rebuildable cache | survivor/cluster |
| reconciliation | §7 | representation-neutral; no destructive merge | no | cache | materialization mechanism |
| historical replay | §6/§10 | pins version-in-force + context | provenance | no | RP15 artifact |
| tenant isolation | §0/§8 | every record tenant-bound; endpoints same-tenant | yes | no | — |

## 5 · Persistence Artifact Classification
Canonical Referent = **A** authoritative persisted fact · Source Referent Binding = **C** immutable historical (+**D** provenance) · Authorized Basis = **C** · Identity Assertion = **C** (authoritative) · Policy Lineage/Version = **B** governed configuration · Evaluation Context/Evaluation = **D** replay/provenance metadata · CII = **E** derived state · CONFLICT = **E** derived state-health · reconciliation projection = **F** optional cache · replay artifact = **D** (form OPEN) · Customer/Supplier IDs = **G** external/feature evidence reference. **[DESIGN-CHOICE / RATIFIED classes]**

## 6 · Canonical Referent Persistence
Must carry **[RATIFIED §4]:** opaque immutable id (**never reused**), tenant (`businessId`), referent **type/domain-qualification** (persisted as *type of anchor*, not truth), mint provenance (which authorized lineage created it, when). **Forbidden as identity truth:** name/phone/taxId/attributes. `referentType` is a semantic requirement; any display/label is **[DESIGN-CHOICE]** convenience. **Duplicates stay possible → NO `@@unique` on any identifier; DB uniqueness must never declare real-world uniqueness.** **[REPO-FACT]** existing `Party` (`prisma/schema.prisma:2129`: id+businessId only) is a valid **precedent shape** — but its `onDelete: Cascade` and `updatedAt` are **not** adopted (§15/§19).

## 7 · Source Referent Binding Persistence
**Append-only provenance artifact [RATIFIED §4/§8]** linking: source-subject **logical reference** (type+id — polymorphic, **not a hard FK**) · authority input · **Canonical Referent** (hard FK) · tenant · temporal applicability · provenance (C0 account ref / source model+version). *"This Customer row was a source subject"* ≠ *"proven same referent."* **Append-only; correction = a new binding referencing the prior, never a rewrite.** **[DESIGN-CHOICE]** subjectId as logical polymorphic ref (mirrors Party `subjectType/subjectId`, `schema:2145-2146`) — acceptable only because the Binding carries no authority.

## 8 · Evidence / Grounds / Authorized Basis
Four historically-distinguishable layers, no collapse **[RATIFIED §2/§8]:** (1) Evidence proposition (reference/provenance; raw identifier value may live in a separable **erasable evidence layer**, §16) → (2) Grounds admitted by policy → (3) **Authorized Basis (immutable)**: refs `PolicyVersion`, typed **Authorization Question**, `EvaluationTime`, contributing grounds, decision-category → (4) **Assertion** refs the Basis. Audit *"why legal then?"* = Basis → PolicyVersion(in-force) + pinned context + EvaluationTime. **`taxId=X → SAME` in one row without a Basis reference is forbidden.**

## 9 · Identity Assertion Store
Authoritative append-only **[RATIFIED §3 AS2/AS3]:** id · tenant · relation `{SAME|DISTINCT}` · two Canonical-Referent endpoints (hard FK, **same-tenant**) · Authorized Basis (hard FK) · recorded-time (immutable) · effective semantics (explicit) · supersession reference (append-only). **`UNRESOLVED` is NOT an Assertion** (RA14); **`CONFLICT` is derived, not a stored relation** (RS9/RC6-b).
- **No-Authorization persistence — [DESIGN-CHOICE / OPEN]:** the contract (RA14/MP25) says No-Authorization need not be materialized as an assertion. **Recommendation:** persist an immutable **Evaluation Record** for replay — **not** an Assertion; whether *every* No-Auth must be persisted vs reconstructed is **not forced** → **not decided here** (classified **[OPEN]** replay-completeness), non-blocking (evaluation records suffice).

## 10 · Correction / Supersession
Append-only **[RATIFIED §3/§10 RP16]:** correction/supersession are **new records referencing prior**; **no rewrite, no destructive correction, no assertion mutation**; provenance + lineage preserved; historical interpretation replayable. **[DESIGN-CHOICE]** represent supersession as an immutable "supersedes → priorId" reference on the new record. **Do NOT invent an unlocked lifecycle state-machine; do NOT copy `PartyClaimStatus {ACTIVE, CHALLENGED, RETRACTED}`** (`schema:2637-2641`) — that is an existing-implementation concept, **not** the RIA contract.

## 11 · Policy Lineage + Version Persistence
`PolicyLineage` (stable governed identity, tenant/scope) + **immutable** `PolicyVersion` (refs lineage; scope, decision-categories, method, PA16 slots, §9 conditions, effective applicability, provenance). **[RATIFIED §10 RP1–RP5/RP16]** **Forbidden:** DB constraint choosing `max(version)` / newest-row / `createdAt DESC` / auto-increment as **selection**; **successor ≠ precedence**; **runtime/DB does not decide the RP4 lineage boundary** (governance-defined). **[OPEN RP4 compound-change; RP16 future/backdated]**

## 12 · Policy Selection / RP15 Design
Requirement **[RATIFIED RP10/RP15]:** reconstruct the *governed selection decision* — selected `(lineage,version)`, normalized selection inputs, EvaluationTime, governed selection basis.
| Option | Determinism | Auditability | Cost | Closes RP15 improperly? |
|---|---|---|---|---|
| **Persist selected version + normalized inputs on an immutable Evaluation Record** | ✓ | ✓ | low | **No** — meets requirement, artifact deferred |
| Registry snapshot reference | ✓ | ✓✓ | med | risks premature artifact lock |
| Candidate-set record | ✓ | ✓✓ | high | risks premature artifact lock |
| Digest/manifest | ✓ | ✓ | low | encoding lock |
**[DESIGN-CHOICE] Recommendation:** the **immutable Evaluation Record** satisfies RP15's reproduce/audit **requirement without choosing the snapshot/candidate-set artifact** → **RP15 stays OPEN, non-blocking.** **[OPEN RP15 artifact]**

## 13 · Temporal Persistence
Represent §6 with **no implicit defaults [RATIFIED]:** immutable **recorded-time**; **explicit** effective semantics (`effectiveFrom`, optional `effectiveTo`/**explicit open-ended/unknown**); **EvaluationTime** pinned on Evaluation Records. **Forbidden:** `effectiveFrom=recordedAt` default · DB insertion/auto-increment order · latest-row-wins as semantic ordering. A rule lacking an effective spec → **temporal default OPEN** (explicit or flagged, never defaulted). **Full bitemporal infrastructure NOT adopted.** **[OPEN temporal default; full bitemporal]**

## 14 · Tenant Isolation
`businessId` on **every** authoritative record; **both Assertion endpoints same-tenant**; Binding cannot link tenant-A subject to tenant-B referent; policy applicability/selection tenant-scoped; replay tenant-scoped. **[RATIFIED §0/§8 PA18/MP26]** Enforcement split: persistence constraints (businessId non-null; same-tenant FKs where representable) + application-level (cross-endpoint tenant check) + **[DESIGN-CHOICE]** defense-in-depth (RLS candidate — **not chosen**, deferred).

## 15 · Referential Integrity
| Relationship | Integrity |
|---|---|
| Assertion → Canonical Referent (×2) | **hard FK**, immutable, **RESTRICT (no cascade)** |
| Assertion → Authorized Basis | hard FK, immutable, RESTRICT |
| Authorized Basis → Policy Version | hard FK, immutable, RESTRICT |
| Policy Version → Policy Lineage | hard FK, immutable, RESTRICT |
| Binding → Canonical Referent | hard FK, RESTRICT |
| Binding → source record | **logical reference** (polymorphic; snapshot/provenance), no hard FK |
| Evidence → external provider/object | logical reference + provenance snapshot |
> **[REPO-FACT / COLLISION]** Existing `Party`/`PartyResolutionClaim` use `onDelete: Cascade` on `business`/`party` (`schema:2135,2159-2160`). **Cascade deletion MUST NOT apply to RIA authoritative history** — it would destroy append-only assertions/replay (§3 AS3, RP16). RIA substrate uses **RESTRICT + explicit archival**, never Cascade. **[DESIGN-CHOICE]**

## 16 · Deletion / Retention / Privacy Collision
Tension: append-only history + replay ↔ business/customer deletion ↔ privacy/erasure **[OPEN]**. **Dangerous:** cascade-delete of assertions on Business/Customer delete → irreversibly destroys audit/replay and could make privacy-erasure *and* replay mutually unsatisfiable. **[DESIGN-REQUIREMENT, not a decision]:** keep **raw PII / identifier values in a separable Evidence/provenance layer** referenced by opaque ref from the immutable authority layer — so the authority layer holds referent-ids + basis-refs (not raw PII), leaving future **pseudonymization/erasure** *possible* **without choosing the mechanism**. **Privacy/erasure semantics NOT resolved.** **[OPEN privacy/erasure]**

## 17 · CII / CONFLICT Persistence Boundary
**CII = derived state; CONFLICT = derived state-health [RATIFIED §7].** Optional materialization allowed **only if** rebuildable · disposable · non-authoritative · versioned/invalidation-safe · never required for historical truth. **A consumer must never treat a materialized CII row as truth merely because it exists.**

## 18 · Reconciliation Persistence Boundary
Representation-neutral **[RATIFIED §7 RC21/RC23]:** **no destructive merge; no survivor/alias/cluster/pointer as semantic truth.** Primitives needed now to keep options open: append-only Assertions (link referents) + derived CII (equivalence-class) — reconciliation is **derivation over assertions**, requiring **no** referent/assertion deletion and **no** feature-history rewrite. **[OPEN survivor/cluster representation]**

## 19 · Existing Party Schema Reuse Audit
| Artifact | Verdict |
|---|---|
| `Party` (id+businessId, no attrs, no unique) | **reusable-after-neutralization** (drop `onDelete: Cascade`; drop `updatedAt`-as-mutable; keep opaque-id + tenant + add referentType/provenance) |
| `PartyResolutionClaim` | **incompatible / scaffold-only** — conflates evidence+authority; `confidence/method/status` + taxId-precedence are semantic leakage (IA6/RA22/MP8) |
| `PartyClaimConfidence/Method/Status` enums | **incompatible** (confidence-as-basis; mutable status-machine) |
| polymorphic `subjectType/subjectId` | **pattern reusable** for Binding (logical ref, no authority) |
| PHONE/TAX_ID signal fields | reusable **only** as evidence, under policy |
| **absence of `@@unique`** | **reusable-as-is** (duplicates legitimate) |
| `onDelete: Cascade` | **incompatible** (destroys append-only history) |
**Conclusion:** the RIA Assertion/Basis/Policy store is a **new additive substrate**, not the Party claim ledger. **No Party migration mechanism is selected.** **[REPO-FACT/DESIGN]**

## 20 · Customer Phone Unique Constraint Analysis
`Customer @@unique([businessId, phone])` (`schema:682`) — **may remain a feature-local operational invariant.** **Means:** at most one Customer row per tenant+normalized-phone. **Does NOT mean:** one real-world referent per phone (IA6). **Does NOT block** two Canonical Referents from existing under RIA (RIA referents are separate from Customer rows). **No change needed before the Minimum ת.ז. proof** (ת.ז. path is phone-independent); change only considered at broader rollout. **No schema change to Customer is part of this stage.** **[REPO-FACT/ARCH]**

## 21 · Minimum ת.ז.-First Persistence Walkthrough
| Step | persisted? | authoritative? | immutable? | tenant? | temporal? | provenance? | rebuildable? |
|---|---|---|---|---|---|---|---|
| source subject | pre-existing (Customer) | feature | — | ✓ | — | ref | — |
| verified ת.ז. binding | Binding (append-only) | provenance | ✓ | ✓ | ✓ | ✓ | no |
| Evaluation Context | Evaluation Record | provenance | ✓ | ✓ | ✓ (EvaluationTime) | ✓ | no |
| selected Policy Version | ref on Eval Record | governed-config | ✓ | ✓ | ✓ | ✓ | no |
| Authorized Basis | Basis | authoritative | ✓ | ✓ | ✓ | ✓ | no |
| SAME/DISTINCT Assertion | Assertion | authoritative | ✓ | ✓ | recorded+effective | ✓ | no |
| CII | projection | **no (derived)** | — | ✓ | at EvaluationTime | — | **yes** |
| replay | Eval+Basis+Assertion+PolicyVersion | provenance | ✓ | ✓ | ✓ | ✓ | reconstruct |
- **SAME:** two subjects, verified same-ת.ז. bindings → SAME Assertion → CII unifies. **DISTINCT:** two verified *different* ת.ז. bindings + affirmative policy → DISTINCT Assertion. **UNRESOLVED:** ת.ז. stored, not authoritatively verified → No-Authorization → **no Assertion**. **CONFLICT:** applicable SAME-closure + applicable DISTINCT → **derived CONFLICT, abstain** (no stored 4th relation). **[RATIFIED §9/§8/§3/§7]**

## 22 · Transaction Boundaries
**[DESIGN-CHOICE] Atomic:** (Authorized Basis + resulting Assertion) · (Canonical Referent mint + initial provenance) · (Evaluation Record write). **Eventually-materialized:** CII/reconciliation projections. **Never half-written:** an Assertion without its Basis. **Idempotent retry** via an operation/evaluation idempotency key — **that key is NOT identity authority** (§23).

## 23 · Idempotency vs Identity
**Explicit invariant [RATIFIED PA25]:** idempotency keys — `wamid`, `providerEventId` (`@@unique([provider, providerEventId])`, `schema:2739`), request-id, C0 `observationAccountId`, evaluation-idempotency-key — are **operational uniqueness, NOT referent identity.** A unique idempotency constraint **must never** become identity authority; retry-dedup ≠ SAME.

## 24 · Query / Index Requirements (requirements, not Prisma indexes)
| Query | semantic key | temporal | tenant | uniqueness |
|---|---|---|---|---|
| assertions for referent | referentId | applicable-at-T | ✓ | non-unique |
| assertions between pair | (refA,refB) ordered | applicable-at-T | ✓ | non-unique |
| applicable assertions @EvaluationTime | referent(s)+effective window | ✓ | ✓ | non-unique |
| bindings for source subject | (subjectType,subjectId) | applicable | ✓ | non-unique |
| bindings by governed identifier namespace | namespace+value | applicable | ✓ | **non-unique** |
| policy selection | lineage/scope/decision-category/time | ✓ | ✓ | one governed result |
| historical replay | eval-record refs | @T | ✓ | — |
**No performance index may become semantic uniqueness.** **[RATIFIED PA25]**

## 25 · Failure / Ambiguity Representation
No-Authorization → Evaluation Record (audit), **not** an Assertion · **selection ambiguity (RP12)** → recorded on Eval Record as an explicit disposition, **category enum NOT finalized [OPEN]** · temporal ambiguity → surfaced (TR26), no auto-order · evaluation Failure → Evaluation Record · external verification unavailable → evidence-absent → No-Authorization · CONFLICT → **derived** (not a stored relation). **Do NOT persist a final disposition-category enum.** **[OPEN RP12]**

## 26 · Replay Design
Reconstruct *"why at T, under then-known knowledge, an Assertion was/wasn't created"* by pinning: Eval Record (selected `(lineage,version)`, normalized inputs, EvaluationTime, selection basis) + Basis + Assertion + PolicyVersion-in-force. Separate **historical-state-query** vs **historical-effective-interpretation** vs **historical-execution-replay** (§6 TR6/TR7/TR8). **Minimum persisted = the above references; RP15 artifact not decided beyond this.** **[RATIFIED §6/§10]**

## 27 · Persistence Alternatives
| Model | fidelity | replay | correction | temporal | tenant | complexity | queryability | accidental-semantics risk |
|---|---|---|---|---|---|---|---|---|
| Normalized authoritative ledger | high | good | append-only refs | good | good | med | good | low |
| Event-oriented ledger | high | excellent | events | good | good | high | needs projections | med (projection-as-truth) |
| **Hybrid** (normalized immutable authority + append-only evaluation journal + rebuildable CII cache) | **highest** | excellent | append-only | good | good | med-high | good | low |
> **[DESIGN-CHOICE] Recommendation: Hybrid** — normalized immutable authority (Referent, Binding, Basis, Assertion, PolicyLineage, PolicyVersion) + append-only **Evaluation/Selection journal** + **derived CII/CONFLICT as rebuildable projections**. Best fidelity to §3 append-only, §6 temporal, §7 derived, §10 selection.

## 28 · Recommended Logical Persistence Model
*(logical only — no Prisma syntax, no SQL, no indexes)*
| Artifact | Why (contract) | Class | Required info | Forbidden |
|---|---|---|---|---|
| **CanonicalReferent** | §4 | A | opaque id, tenant, referentType, mint provenance | attrs/PII as truth; identifier-uniqueness; Cascade |
| **SourceReferentBinding** | §4/§8 | C/D | (subjectType,subjectId) logical ref, authority input, referent ref, tenant, temporal, provenance | FK-as-authority; rewrite |
| **AuthorizedBasis** | §2/§8 | C | policyVersion ref, authorization-question, decision-category, EvaluationTime, grounds refs, tenant | mutation; missing policy ref |
| **IdentityAssertion** | §3 | C | relation, referentA/B refs (same tenant), basis ref, recorded+effective, supersedes ref, tenant | mutation/delete; CONFLICT as relation; cross-tenant |
| **PolicyLineage** | §10 | B | id, scope, tenant | DB-derived lineage boundary |
| **PolicyVersion** | §10 | B | lineage ref, immutable content, effective applicability, provenance | mutation; latest-wins |
| **EvaluationRecord** | §8/§10 RP15 | D | question, context, EvaluationTime, selected policyVersion, selection basis, disposition | disposition-category-as-final-enum |
| **CIIProjection** *(optional)* | §7 | F | derived equivalence-class, rebuild key | authority; required-for-truth |
> **[DESIGN-CHOICE].** These are logical artifacts and required-information categories — **not** Prisma models, tables, columns, indexes, or relations.

## 29 · Constraint Matrix
- **Semantic (governance):** immutable Assertion/Basis/PolicyVersion · same-tenant endpoints · no real-world uniqueness · CII non-authoritative · no latest-policy-wins · successor≠precedence.
- **Persistence integrity:** tenant non-null everywhere · hard references immutable + **RESTRICT** · append-only (no update/delete on authority) · idempotency key ≠ identity.
- **Application enforcement:** cross-endpoint tenant check · RP4 lineage boundary (governance) · deterministic selection · RP12 surfacing.
- **Defense-in-depth (impl-time):** RLS · triggers preventing update/delete of authority rows. **[DESIGN-CHOICE]**

## 30 · Existing-Schema Collision Report
| Artifact | Current | RIA requirement | Severity | Blocker now? | Stage | Semantic/technical |
|---|---|---|---|---|---|---|
| Party/Claim `onDelete: Cascade` (`schema:2135,2159`) | cascade-delete on business/party delete | RESTRICT; append-only survives | High (if reused) | **No** (RIA additive; Party dormant) | Party neutralization (pre-go-live) | technical |
| PartyResolutionClaim semantics | belief+precedence ledger | Assertion via policy; no confidence-as-basis | High | No | Party reconciliation | semantic (already governed PA24/IA6/RA22) |
| `Customer @@unique([businessId,phone])` | phone=customer key | feature-local; phone≠cross-referent SAME | Low | No | broader rollout | technical/none |
| Supplier missing `taxId` | none | needed for SUPPLIER tax-id signal | Med | No | before Documents/Inventory RIA | technical (additive) |
| `PartyRoleType` missing SUPPLIER | CUSTOMER/LEAD | SUPPLIER role later | Med | No | before supplier RIA | technical (additive) |
| feature-local FKs / nullable snapshots | evidence/join | remain evidence | Low | No | — | none |
**No collision blocks the additive RIA substrate or the ת.ז.-first path.** **[REPO-FACT]**

## 31 · Migration Boundary (design-only classification)
**additive RIA substrate** (new artifacts — no touch to Party/Customer) · **legacy Party neutralization** (pre-go-live) · **existing-data backfill** (Customer/Lead → bindings, later) · **future Supplier expansion** (taxId + SUPPLIER role, later) · **materialization/cache** (rebuildable) · **cleanup/deprecation** (last). **Default: additive + reversible before any destructive step. No migration plan/SQL written here.** **[DESIGN-CHOICE]**

## 32 · Security / Integrity Requirements
tenant isolation (§14) · authorization boundary = only RIA writes authority rows · **immutable audit history** (append-only, no update/delete) · application-level tamper resistance · **PII minimization** — raw identifier values in separable evidence layer; authority layer holds opaque refs (§16) · identifier-exposure/logging discipline · replay access read-only/audited. **No broad security redesign.** **[ARCH]**

## 33 · Testability Requirements
cross-tenant insert rejected · Assertion immutable (update/delete blocked) · correction preserves history · deterministic reconstruction · no future leakage · policy-version pinning · **same digits w/o verified basis → no Assertion** · **phone-only → no RIA SAME** · **different unverified IDs → no DISTINCT** · CII rebuild-equivalence · **materialization deletion doesn't destroy truth** · idempotency retry doesn't duplicate Assertion · **legacy Party cannot independently authorize identity**.

## 34 · OPEN Dependency Reassessment (post-model)
- **A · persistence-neutral:** PA14(b) · RP4 compound-change · precedence · composition · Minting · RESOURCE · COMMITMENT · OTHER · CONFLICT-exit · full bitemporal · ח.פ. reassignment · ת.ז. post-death · phone recycling · phone/email corroboration.
- **B · representation abstract (slot, not final):** RP15 reproduction artifact · RP12 disposition category · reconciliation representation · CII materialization form · temporal default.
- **C · must resolve before schema implementation:** **NONE.**
- **D · before later rollout:** Party migration mechanism · Supplier taxId + SUPPLIER role · privacy/erasure mechanics · phone/email corroboration.
**No OPEN moved from non-blocking to blocking; none resolved here.** **[OPEN]**

## 35 · Exact Recommended Next Stage
**RIA Implementation Substrate — Pre-Implementation** (separate task): translate §28's logical model into a concrete **additive** store, honoring §29, **without** reopening §0–§10, closing any OPEN, or letting schema become authority. Do **not** touch Party/Customer; do **not** create SUPPLIER role / Supplier.taxId (later rollout). **[ARCH]**

## 36 · STOP-Condition Result
**No STOP triggered:** append-only history representable · tenant isolation representable · RP15 not forcing (Eval Record meets requirement) · correction needs no unlocked lifecycle (append-only, no status-machine) · privacy/erasure kept *possible* by PII-layer abstraction without deciding it · existing Party schema **not reused** so forces nothing · Customer-phone-unique doesn't block ת.ז.-first · Canonical Referent needs **no** uniqueness · schema **represents**, never defines, authority. **No missing contract invented.**

## 37 · Final Decision Gate
> **A — PERSISTENCE DESIGN READY FOR IMPLEMENTATION SUBSTRATE.** Complete logical persistence contract (Hybrid model, §28); no semantic blocker; every OPEN preserved (RP15/RP12/temporal-default as abstract slots); existing-schema collisions handled by **additivity** and deferred. The database faithfully *preserves* the locked semantics and *leaves the OPENs open* — it decides no identity, no policy winner, no phone=identity, no latest=applicable, no cache=truth.

---

*Semantic authority: `docs/referent-identity-authority-v1.md` (RIA-1 §0–§10). Architecture authority: `docs/referent-identity-authority-runtime-architecture-v1.md`. This persistence-design document is subordinate to both and introduces no new semantic governance and no implemented schema.*
