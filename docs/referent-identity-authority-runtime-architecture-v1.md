# RIA-1 · Production Runtime Architecture v1

**Status:** ARCHITECTURE-ACCEPTED (Verdict A) · **Version:** v1 · **Scope:** runtime architecture / responsibilities & boundaries — **not** persistence schema, **not** implementation.

> This document materializes the Production RIA Runtime Architecture as a versioned in-repo artifact so that the next stage (**Persistence Design**) can rely on a reviewed document on `main` rather than conversation history. The **canonical semantic authority remains `docs/referent-identity-authority-v1.md` (RIA-1 §0–§10)**; this document does not restate governance — it maps it to the runtime.

**Wording discipline — every material statement is tagged:**
- **[RATIFIED]** — mandated by RIA-1 §0–§10 (canonical governance).
- **[REPO-FACT]** — found firsthand in the repository audit (with file:path).
- **[ARCH]** — an architectural decision/responsibility derived from governance + repository reality; it does **not** close any OPEN.
- **[OPEN]** — deferred; this document must **not** resolve it.

---

## 1 · Purpose & Status
Define the **responsibility- and boundary-level** architecture for a Production Referent Identity Authority (RIA) that is the single **cross-feature** identity authority of Dubiz — without creating a second identity engine, without promoting feature-local IDs/matchers to authority, and without inventing semantics that RIA-1 leaves OPEN. **[ARCH]** Verdict of the preceding audit: **A — architecture ready for Persistence Design; no semantic blocker; no existing-runtime collision.** **[ARCH]**

## 2 · Relationship to RIA Governance §0–§10
RIA-1 §0–§10 (`docs/referent-identity-authority-v1.md`) is the **sole semantic authority**. This architecture **consumes** it and may not alter it. Where implementation reality conflicts with governance, the architecture **surfaces the mismatch** and defers to governance. **[RATIFIED]/[ARCH]**

## 3 · Architectural Principles
- RIA is **post-C0**; it consumes immutable C0 Evidence and never mutates it. **[RATIFIED §0]**
- **Only RIA emits Identity Assertions** (RA2). Evidence/verification/feature-code are inputs, never authority (RA3/RA4). **[RATIFIED §2]**
- Identity **Assertions are immutable, append-only**; **Identity State/CII is derived** (never persisted truth). **[RATIFIED §3/§7]**
- **Canonical Referent = tenant-scoped anchor, not a truth container.** **[RATIFIED §4]**
- Authorization flows only through a **versioned Method Policy** (§8/§10); **no signal→assertion shortcut.** **[RATIFIED §5/§8]**
- **Tenant isolation is a hard invariant.** **[RATIFIED §0/§8 PA18]**
- **DB uniqueness / FK / persistence-order are never identity authority.** **[RATIFIED §8 PA25/RC16]**

## 4 · Repository Audit Baseline
Audit performed READ-ONLY against `origin/main = 4cb345d` (RIA-1 §0–§10 present; PR #199/#196/#193 landed). Main had advanced from `7130d82` only via **#173** (inbox URL) and **#200** (docs-security) — **neither affects RIA**. **[REPO-FACT]**

## 5 · Governance → Runtime Constraint Mapping (abridged)
| Governance | Runtime responsibility | Runtime MUST NOT | OPEN |
|---|---|---|---|
| §2 Authority; §8 Authorized Basis | Authorization Evaluator (policy→Basis/No-Auth/Failure) | let evidence/verification authorize by itself | — |
| §2 RA2 RIA-only-asserts | single Assertion Authority | let features/Party emit identity | — |
| §5/§10 Method Policy, Lineage, Version | Policy Registry + deterministic Selection | derive lineage from DB key; runtime-decide lineage boundary | RP4 compound-change |
| §8 PA17/§10 RP10–12 selection | one governed Evaluation Plan; multi-applicable → explicit surface | first-match/latest/most-specific/precedence | RP12 category |
| §4 Canonical Referent | anchor authority | store attributes as truth; reuse id | — |
| §3 Assertion | append-only immutable store | edit/delete/reinterpret | — |
| §1/§7 RC6-b CONFLICT | derived Conflict Detection; abstain | SAME-wins/DISTINCT-wins/graph-cut | CONFLICT-exit |
| §6 temporal | Applicability + Replay (explicit EvaluationTime) | `effectiveFrom=recordedAt`; DB-row/auto-increment as ordering; auto-reprocess on backdate | temporal default; RP16 |
| §7 CII/reconciliation | derived CII; cache-only materialization | treat CII/cache as authority; destructive merge | survivor/cluster repr |
| §8 PA24 Party | RIA is sole authority | dual authority store | Party migration mechanism |
| §9 identifiers | per-identifier authority only under policy | phone/email→SAME-alone; VAT-status→identity | phone/email corroboration |

## 6 · Existing RIA Proof Boundary
`lib/referent-identity/**` is an **executable proof/foundation only** (fixtures; no DB/persistence/wiring). **[REPO-FACT]** Reusable **contract-shaped** conceptual foundation: `ria.types.ts`, `cot-to-binding.ts` (grounds-only adapter), `identity-resolver.ts` (RIA-only-asserts, append-only), `cii-derivation.ts` (SAME-closure + RC6-b, no cut), `ria-replay.ts`. **Proof-only mechanics that MUST NOT be copied to production:** `fixtures/fixture-identity-policy.ts` (token-set / `affirmativeDistinctFrom` / X5b ambiguity-guard are **proof artifacts, not production authority**). **[ARCH]** Production selection/evaluation follows §8/§10 (single-category questions, PA14(b) OPEN, no precedence). **[RATIFIED]**

## 7 · C0 Boundary
C0 (`lib/business-brain/**`) supplies an **immutable, deep-frozen `CanonicalObservation`** with content-derived ids, tenant, source, `referent{referentType, identityBinding}`, value, provenance, pinned ExecutionContext (registry snapshot). **[REPO-FACT]** **Boundary:** C0 owns observation identity (hashing) + the translator's `identityBinding` as **grounds only**; RIA owns referent identity (authority). The C0 `identityBinding.kind=RESOLVED{entityType,entityId}` **must remain grounds, never auto-promoted to RIA SAME** (PA25). **RIA must not change the C0 contract.** **[RATIFIED/ARCH]**

## 8 · Equality Consumer Boundary
`lib/detection-grammar/equality/**` consumes two C0 accounts and returns a **value relation** (`EQUAL/NOT_EQUAL/Failure`), orthogonal to identity; UNWIRED (fixtures). **[REPO-FACT]** **[ARCH]** Production RIA supplies consumers a **derived CII** (identity alignment) they read without becoming authority; consumers must accept **UNRESOLVED and CONFLICT without a forced winner**. Equality must not be changed here. **[RATIFIED §1]**

## 9 · Current-State Identity Map
```
Feature   → local entity    → identifier/evidence      → current mechanism            → authority class            → RIA impact
Customer   → Customer        → (businessId,phone) UNIQUE→ find-or-create (WhatsApp)    → feature-local Tier-2 key    → evidence source (phone signal); RIA above
Customer   → Customer        → taxId (stored)           → none                         → storage-identity            → future ת.ז./ח.פ. binding source
Supplier   → Supplier        → name/phone/email         → advisory findPossibleMatches → forbidden-authority         → RIA becomes the resolver it defers to
Party      → Party+Claim     → PHONE/TAX_ID             → dormant backfill (unwired)   → potential-authority         → subordinate/absorb under RIA (design space)
Documents  → FinancialRecord → vendorName + tax-id sig  → name-string pick only        → external-signal             → future SUPPLIER seam at record create
Payments   → PaymentRequest  → customerId (pre-set)     → none                         → storage-identifier          → route existing customerId through RIA
Inbox      → Customer        → phone                    → upsertCustomer by phone      → implicit (feature-local)    → first wiring target (as evidence)
Inventory  → Supplier        → name/phone               → advisory                     → possible-grounds            → future SUPPLIER role + taxId
```
**No box is a live cross-referent authority.** **[REPO-FACT]**

## 10 · Customer Findings
`Customer @@unique([businessId, phone])` (`prisma/schema.prisma:682`) is the **only enforced real-world natural key**. **[REPO-FACT]** `createCustomer` plain-create; `upsertCustomer` find-or-create by normalized phone (WhatsApp, §15); edit-guard `PHONE_TAKEN` on P2002 (`lib/services/crm/customer.service.ts:210-217`). `taxId`/`legalName`/`taxIdType` are **validate-and-store only — never used to resolve/dedup** (`lib/billing/customer-tax-identity.ts`). `customerId` is a **nullable FK + frozen snapshot** across billing/appointments/payments/conversations; billing **snapshots identity at issue** (`lib/services/billing/billing-issue.service.ts:258,554-572`). **[REPO-FACT]** **[ARCH]** RIA generalizes the snapshot-at-event evidence pattern; the phone key stays feature-local.

## 11 · Supplier Findings
`Supplier` has **no taxId, no legalName, no unique constraint** (`schema:1745-1762`); `createSupplier` "never block, never auto-merge" (`lib/services/inventory/supplier.service.ts:141`); `findPossibleMatches` **advisory, writes no canonical link** (`:240-243`); `PurchaseOrder.supplierId` optional + `supplierName` snapshot, **trusts caller** (`lib/services/inventory/purchase-order.service.ts:366-383`); intake stores a free string. **[REPO-FACT]** **[ARCH]** RIA becomes the resolver these advisory mechanisms defer to.

## 12 · Party / PartyResolutionClaim Findings
**Dormant potential authority — NOT a live competing authority.** **[REPO-FACT]** Reachable **only** via `scripts/party-backfill.ts` (script-only; default dry-run **rolls back**; execute **hard-blocked in production**; migration-gated); **zero** route/API/cron/service caller; **no consumer reads it**; one-way from Customer/Lead; **append-only** (only `.create`; CHALLENGED/RETRACTED never written). `Party` (`schema:2129`) = minimal tenant anchor; `PartyResolutionClaim` (`:2141`) = append-only claim ledger; signals `{PHONE,TAX_ID}`, roles `{CUSTOMER,LEAD}` only. **[REPO-FACT]**
> **Its current implementation is NOT the Production RIA design.** If wired as-is it would conflict with RIA: **PHONE-alone identity behavior** (vs IA6 phone-never-alone-SAME), **taxId/phone precedence** (`resolvePartyForRoleRowTx:424`, vs RA22 no-precedence), **confidence-based semantics** (vs MP8 confidence-alone-never). **[ARCH]**
> **It must not be independently wired as an identity authority** (PA24). absorb / wrap / deprecate remain **design space — not chosen here.** **[RATIFIED/OPEN]**

## 13 · Documents Findings
Documents pick a vendor **NAME string only**; tax-id is a scoring/anchor signal **never resolved to a managed entity**; `FinancialRecord.vendorName` is bare (**no supplierId/partyId FK**) (`lib/services/documents/decision/resolve-final-entities.service.ts:1073`; approve route `:175`). `VendorLearning` is a name→category memory (`vendorNameNormalized` is a shadow key). **[REPO-FACT]** **[ARCH]** Future SUPPLIER integration seam is at `FinancialRecord` create + `vendorNameNormalized`.

## 14 · Payments Findings
Payments **never derive counterparty identity**; provider verification is authority over the **money outcome, not who** (`lib/services/payments/payment-webhook.service.ts:237,305`); `PaymentRequest.customerId` is a **pre-set FK**; `providerRequestId/TransactionId/EventId` are **idempotency/storage-identifiers**. **[REPO-FACT]** **[ARCH]** RIA seam = route existing `customerId` at request creation; provider ids stay storage-identifiers, never promoted to identity.

## 15 · Inbox / WhatsApp Findings
The **one live implicit identity behavior**: `upsertCustomer` find-or-create by `(businessId, phone)` (`lib/services/integrations/whatsapp/conversation-intake.service.ts:142-152`); shares `normalizeCustomerPhone` with the RIA proof's PHONE signal; wamid/hash = idempotency. **[REPO-FACT]**
> **This is feature-local operational identity behavior — NOT RIA authority.** In RIA, **phone remains evidence / potential governed grounds and is never standalone SAME authority** (IA6). The mechanism is **not changed** here; RIA sits above it as an evidence source. **[ARCH/RATIFIED]**

## 16 · Inventory / Procurement Findings
Feature-local `Supplier`; advisory matching; PO trusts caller `supplierId`; **no customer/POS identity** (external sales anonymous). **[REPO-FACT]** **[ARCH]** Future SUPPLIER integration requires an identity surface (role + tax-id) — a **rollout dependency**, not created now.

## 17 · Production RIA Runtime Responsibilities (interfaces, not classes/tables)
**[ARCH]** Policy Registry (governed lineage+version enumeration/resolution) · Deterministic Policy Selection (pinned context → one Evaluation Plan; multi-applicable → explicit surface) · Evaluation-Context Builder (from admitted evidence) · Authorization Question (typed, single decision-category) · Authorization Evaluator (policy → Basis | No-Authorization | governed Failure) · Canonical-Referent Authority (mint/manage anchors; not truth containers) · Source-Referent-Binding (package C0/feature grounds + authority input; **no resolution**) · **Assertion Authority (RIA-only, append-only, immutable)** · Applicability Engine (§6 temporal) · **CII Derivation (derived only)** · Conflict Detection (RC6-b) · Replay/Reconstruction (deterministic; pins version-in-force) · Reconciliation Projection (cache only, if any) · Consumer Boundary (expose CII read; no consumer authority).

## 18 · Source-of-Truth Matrix
| Concept | Classification |
|---|---|
| Canonical Referent (anchor id) | **authoritative persisted fact** (immutable, tenant-scoped) |
| Source Referent Binding | provenance (derived from immutable C0 + authority input) |
| Authorized Basis | **immutable historical fact** (assertion provenance) |
| Identity Assertion | **immutable historical fact** (append-only) |
| Method Policy Lineage / Version | **governed configuration** (version immutable) |
| Evaluation Context / Evaluation | replay/provenance metadata / derived-transient |
| **CII** | **derived state — NOT persisted truth** |
| **CONFLICT** | **derived state-health** |
| reconciliation view | **cache/materialization — NOT authority** |
| Customer/Supplier/Party DB IDs | **storage/feature identity — NOT authority** |

## 19 · Evaluation / Authorization Flow
`C0/feature observation → evidence acquisition → Source Referent Binding (grounds + authority input) → deterministic Policy Selection (pinned context) → typed Authorization Question → Authorization Evaluation → {Authorized Basis | No-Authorization | governed Failure} → (if Basis) RIA Assertion (append-only) → applicability (§6 EvaluationTime) → derived CII → consumer → replay/audit`. **[ARCH/RATIFIED]**

## 20 · SAME Path
Verified binding + applicable policy → **SAME Authorized Basis** → RIA Assertion → CII members unify (equivalence-class). **No shortcut** (identifier alone never SAME). **[RATIFIED §1/§9]**

## 21 · DISTINCT Path
**Two independently authoritative verified bindings + policy affirmative** → **DISTINCT Authorized Basis** → constrains CII. **Never** from raw inequality / mismatch / no-match / failed-SAME / stale verification. **[RATIFIED §9 IA9/IA11]**

## 22 · No-Authorization / UNRESOLVED Path
Valid evaluation, insufficient authority → **No-Authorization** → **no Assertion** → referents stay un-unified (**UNRESOLVED is healthy**). **[RATIFIED §2 RA14/§8 PA26]**

## 23 · CONFLICT Path
Two applicable contradictory Assertions → derived **CONFLICT → abstain** (RC6-b); **no** SAME-wins/DISTINCT-wins/graph-cut/best-guess. **No early PA14(b) authority-layer disposition is invented.** **[RATIFIED §1/§7]** **[OPEN PA14(b); CONFLICT-exit]**

## 24 · Temporal / Applicability Architecture
Distinct axes: **recorded/knowledge-time · effective/valid · EvaluationTime**; three questions separate (Knowledge-As-Of ⊕ Effective-State-At ≠ Historical-Execution-Replay). **No `effectiveFrom=recordedAt` default; no DB-row/auto-increment/persistence-order as semantic ordering** — if needed without a semantic contract, **surface (TR26), do not invent**. Replay **pins version-in-force**; backdated-effective policy **does not auto-reprocess**. **[RATIFIED §6/§10 RP14]** **[OPEN temporal default; RP16 future/backdated]**

## 25 · Tenant-Isolation Architecture (requirements)
Tenant context is a **governed, server-derived** input (never client-supplied-as-authority); **every** RIA operation is tenant-scoped; **Canonical Referents/Assertions/Bindings cannot cross tenants**; cross-tenant inputs → **invalid/Failure, never SAME/DISTINCT**; replay is tenant-safe. **[RATIFIED §0/§8 PA18/MP26]** (RLS/mechanism deferred — **[OPEN]** persistence representation.)

## 26 · Replay / Reconstruction Architecture
Deterministic reconstruction pins policy **(lineage,version)** in force + selection context + admitted inputs + EvaluationTime + relevant identifier/lifecycle facts. **RP15 requires reproduce/audit of the governed selection decision — the snapshot/candidate-set/digest/manifest artifact stays DEFERRED.** **[RATIFIED §6/§10 RP15]** **[OPEN RP15 artifact]**

## 27 · Reconciliation / Materialization Boundary
Reconciliation is **representation-neutral**; any materialized CII/reconciliation view is a **non-authoritative cache** over the derived truth. **Materialized state never defines identity truth; no destructive merge.** **[RATIFIED §7 RC21/RC22]** **[OPEN survivor/cluster/pointer representation; materialization mechanism]**

## 28 · Legacy Party Integration Design Space
Because Party is **dormant** (no live collision), the following are **open design options — none chosen** (needs governance + migration evidence not yet present): **(O1) absorb/rebuild** · **(O2) wrap as evidence/candidate adapter** · **(O3) deprecate**. **Locked (PA24):** it **cannot remain a competing authority once RIA is live**; if activated as-is it violates IA6/RA22/MP8. This is a **before-go-live** decision, downstream of Persistence Design. **[RATIFIED/OPEN]**

## 29 · Minimum ת.ז.-First Production Path
`real PARTY natural-person → verified ת.ז.→person binding → applicable Method Policy (IA1) → Authorized Basis → RIA Assertion → derived CII → consumer → deterministic replay`. Fully governed by §9 IA1/IA2/IA9 + §8 + §10 + §3 + §7 + §6 — **no new governance needed**. **Not chosen here:** verification provider/API. **Luhn ≠ verification; same digits alone ≠ SAME; different digits alone ≠ DISTINCT; affirmative DISTINCT needs two verified bindings + policy; insufficient authority → No-Authorization.** **[RATIFIED/ARCH]** **[OPEN ת.ז. verification integration; ת.ז. post-death guard]**

## 30 · Persistence Requirements — Requirements Only
**[ARCH]** append-only Assertion history · Canonical Referent anchors (immutable id, tenant-scoped, never-reused) · Policy lineage/version preservation (immutable versions) · full provenance (basis/grounds/policy-version/EvaluationTime) · mandatory tenant scoping on every record · dual-time applicability (recorded+effective; **no default**) · deterministic **selection reconstruction** · correction/supersession as append-only history · **CII non-authoritative** · **reconciliation materialization non-authoritative**.
> **This document defines NO Prisma models, table names, SQL, indexes, migrations, database-specific representation, or the RP15 artifact.** Those belong to Persistence Design. **[OPEN persistence representation]**

## 31 · Test Strategy (architecture level)
unit (applicability, replay, binding-grounds-only) · contract (RIA-only-asserts; SAME/DISTINCT/UNRESOLVED; no-silent-winner; no-match/mismatch≠DISTINCT; phone/email≠SAME-alone & ≠DISTINCT; DB-ID/FK≠authority; VAT-status≠identity; deterministic selection; multi-applicability→explicit surface) · integration (C0→binding→policy→basis→assertion→CII; consumer accepts UNRESOLVED/CONFLICT) · replay/golden (determinism; no future-leakage; version-in-force pinning) · cross-feature (shared CII; Equality orthogonal) · temporal (three questions distinct; backdate≠reprocess) · tenant-isolation · migration/compat (Party subordination; snapshots unchanged; **fixture-policy isolation**). **[ARCH]**

## 32 · Rollout Sequencing
`Runtime Architecture → Persistence Design → Implementation Substrate → Minimum ת.ז. Production Proof → Party reconciliation/migration → CRM → Documents (+SUPPLIER role +Supplier.taxId) → Payments (route customerId) → Inbox (wire upsertCustomer as evidence) → Suppliers/Inventory (+Supplier.taxId) → broader identifier policies`. **[ARCH]** Inserted prerequisites: **SUPPLIER PartyRoleType + Supplier.taxId** precede Documents/Inventory RIA (rollout dependency, **not created now**); **Inbox** is the cleanest first wiring.

## 33 · Risk Register
| Risk | Source | Mitigation (invariant) |
|---|---|---|
| phone → cross-referent-SAME leakage | WhatsApp upsertCustomer | phone stays feature-local evidence; IA6; RIA above |
| Party wired as-is → violates IA6/RA22/MP8 | dormant resolver | PA24 subordination; never wire independently |
| taxId promoted to authority without verification | Customer.taxId stored | IA12 proposition-specific source; store≠authority |
| CII/reconciliation cache mistaken for truth | future materialization | SoT matrix: derived/cache only |
| DB FK/uniqueness → identity | customerId / (businessId,phone) | PA25/RC16 |
| provider/webhook signal → identity | payments | classified storage-identifier only |
| fixture policy copied to production | `lib/referent-identity` proof | class-C leakage guard; forbidden-shortcut |

## 34 · OPEN Dependency Classification
- **A — not required for architecture (runtime-neutral):** PA14(b) · RP4 compound-change · RP12 disposition category · RP16 future/backdated retirement · precedence · inter-policy composition · concrete Minting · RESOURCE · COMMITMENT · OTHER · CONFLICT adjudication/exit · full bitemporal infrastructure.
- **B — resolved inside the next stage (Persistence Design):** persistence representation · RP15 reproduction artifact.
- **C — before the ת.ז. Production Proof (not before Persistence Design):** ת.ז. verification integration · ת.ז. post-death reuse guard.
- **D — before broader rollout:** SUPPLIER role + Supplier.taxId · phone/email corroboration · phone recycling · ח.פ. reassignment uncertainty · Party migration mechanism · privacy/erasure mechanics.
**No OPEN is closed by this document.** **[OPEN]**

## 35 · STOP Conditions (for downstream stages)
Stop and surface, do not self-resolve, if any of these arise: a semantic decision not covered by §0–§10; a governance contradiction; an existing-runtime collision that cannot be designed around without a focused decision; a temporal ordering required without a semantic contract; authority ambiguity about who may emit an Assertion. In such a case present the exact question and the contract/runtime dependency that makes it blocking — **never invent it, never auto-open §11.** **[ARCH]**

## 36 · Final Architecture Verdict
> **A — ARCHITECTURE READY FOR PERSISTENCE DESIGN.** The architecture faithfully represents RIA §0–§10, maps the existing reality, keeps every OPEN open where non-blocking, and enables Persistence Design without the schema inventing semantics. The single live identity mechanism (WhatsApp phone→Customer) is a within-domain feature-local key that RIA sits above as an evidence source — not a cross-referent collision. **No semantic blocker; no STOP condition triggered.** **[ARCH]**

## 37 · Explicit Next-Stage Gate
The next stage is **RIA Persistence Design** — and only after this artifact lands on `main`. Persistence Design must translate §30 (requirements) into a concrete store **without** reopening §0–§10, without closing any OPEN, and without letting schema become authority. **This document does not begin Persistence Design.** **[ARCH]**

---

*Semantic authority: `docs/referent-identity-authority-v1.md` (RIA-1 §0–§10). This runtime-architecture document is subordinate to it and introduces no new semantic governance.*
