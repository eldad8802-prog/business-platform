# Dubiz — Business Memory Materializer / Writer · Pre-Implementation Design v1

> **Status: PRE-IMPLEMENTATION DESIGN — NO WRITES.** Read-only. Designs the FIRST write contract of Business Memory (Evidence Adapter → Memory Deriver → Derived Claim Projection/Candidates/EvidenceLinks) without writing a single row. This is the last gate before the first partial activation. Implements Contract v1 (RATIFIED) + Architecture v1 + Persistence Design v1 + Claim persistence pre-impl v2. Where any tension arises, **Contract v1 governs**.
> **Baseline:** `origin/main f5d8e3f` (Claim substrate merged + prod-deployed 2026-08-18; Adapter + Deriver merged, inert). Firsthand-revalidated.
> **Type:** a design. No Prisma / SQL / migration / write / branch / commit / PR.

---

## 1. Baseline (firsthand)
- **Claim substrate:** `DerivedClaimProjection` + `DerivedClaimCandidate` + `DerivedClaimEvidenceLink` exist on main **and in Production** (deploy run 32085289373, up-to-date). **0 prisma consumers** of the Claim OR policy tables.
- **Evidence Adapter (IMPL-2):** `readOwnerDecisionEvidence(businessId, subject) → OwnerDecisionEvidenceSet { subject, items, identity }` — inert.
- **Memory Deriver (IMPL-3):** `deriveVendorCategory(evidenceSet, policyVersionId, options?) → DerivedClaimResult { subject, claimType, policyVersionId, evidenceSetIdentity, state, candidates[] }` — pure, inert. `candidate = { claimType, propositionValue, supportingRefs[] }`.
- **DerivationPolicy / DerivationPolicyVersion:** exist, **EMPTY** (no seed, no writer — firsthand: no `derivationPolicy*.create` anywhere).
- **VendorLearning:** still the live runtime path (`decideCategory` reads it). Untouched.
- **No writer / materializer / Claim reader anywhere.** Revalidation clean → no REVALIDATION-REQUIRED.

## 2. Materializer responsibility (contract)
> **The Materializer takes one already-derived `DerivedClaimResult` and atomically replaces the corresponding derived projection slot** `(businessId, subjectDomain, subjectNormalizedKey, claimType, policyVersionId)`.

It does **not**: read raw `ReviewEvent`; decide/select policy; run recommendation; mutate canonical evidence; touch `VendorLearning`; pick a winner; compute confidence; normalize a vendor. **Derivation logic stays in the Deriver only.**

## 3. Orchestration boundary
| A · Materializer receives `DerivedClaimResult` | B · Materializer reads+derives+writes | **C · Orchestrator + narrow persistence Writer** |
|---|---|---|
- **B** collapses evidence + semantics + persistence into one unit — worst testability/atomicity, couples the writer to Adapter+Deriver.
- **C (recommended):** keep the four concerns separate — **Adapter** (evidence), **Deriver** (semantics), **Writer** (persistence), **Orchestrator** (sequencing only). The Writer becomes a pure, narrow, unit-testable persistence function; the Orchestrator wires Adapter→Deriver→Writer + the stale-evidence guard (§7).
> **Recommendation: C.** And the **first slice is the narrow Writer alone** (W1, §23) — the Orchestrator is a later slice.

## 4. Transaction boundary
One projection slot; the write is **atomic (all-or-nothing)**: validate tenant/input → resolve slot → replace old derived rows → write Projection → write Candidates → write EvidenceLinks → commit. **Any step failing rolls back the whole transaction; the prior slot stays intact; never a partial candidate-set.**

## 5. Replace semantics
> **Transactional delete-slot + insert-fresh, inside one interactive `$transaction`:** delete the existing Projection for the slot (cascade drops its Candidates → EvidenceLinks) → insert the new Projection + Candidates + EvidenceLinks.
- Rejected: "upsert root + diff children" (needs child-set diffing — more complex, same result); "create replacement then swap" (needs a second slot — the unique key forbids two).
- **No Claim history is built** to avoid a delete (Contract: canonical history is the evidence, not the cache). Simplest path with atomicity + idempotency.

## 6. Idempotency contract
Same `(business, subject, claimType, policyVersion, evidenceSetIdentity)` replayed → **same DB state**. By construction (delete+insert-fresh) the final state is deterministic → idempotent. **Optional optimization:** if the stored `evidenceSetFingerprint` equals the incoming one *and* the candidate/link set matches → **no-op** (skip the write) to avoid churn. The fingerprint is a **no-op/staleness aid only — never authority**. Observable result ∈ `created | replaced | deleted | no-op`.

## 7. Stale-evidence race (the critical concurrency contract)
Scenario: Adapter reads set A → Deriver result A → a new `ReviewEvent` makes set B → Writer writes stale A.
> **Optimistic-consistency contract (no timestamp/latest heuristic):** the materialization command carries the `evidenceSetIdentity` it was derived from. **Immediately before the write transaction, the Orchestrator re-reads the current evidence identity via the Evidence Adapter for the same subject; if it differs from the command's identity, the derivation is STALE → abort and re-derive (do NOT write).** Inside the transaction, concurrent same-slot writers are serialized by the Projection unique constraint + row locks.
- Residual window (revalidate→commit): a change there triggers a fresh derivation that re-writes → **transient staleness is acceptable and self-correcting**; a stale projection can never persist indefinitely because its evidence identity would no longer match on the next derivation.
- Stronger guarantee (serializable isolation / per-slot advisory lock) is an **option, deferred** — the optimistic contract is sufficient for shadow mode.
- **Forbidden:** resolving staleness by "latest timestamp wins."

## 8. Tenant consistency — Writer-enforced (DB does not enforce it)
The DB enforces Projection→Business ownership, but **not** that an EvidenceLink's tenant matches its Projection (no composite FK — pre-impl v2 §18). Therefore the **Writer MUST enforce, before any mutation:**
- `result.subject.businessId == target businessId`;
- every `candidate.supportingRefs[*].businessId == target businessId`;
- every `evidenceSetIdentity.refs[*].businessId == target businessId`.
Any mismatch → **reject the whole write before the transaction** (no partial mutation). This is the writer-time invariant; lock it in tests.

## 9. Evidence integrity
The Writer receives **refs, not raw evidence**. Options: (A) trust Deriver output · (B) read-back via Adapter to confirm refs exist · **(C) minimal structural validation**.
> **Recommendation: C at the Writer** (refs well-formed, same-tenant, non-empty per persisted candidate, subset of the evidence set — §12/§13). **Any existence recheck goes through the Evidence Adapter at the Orchestrator, never a `ReviewEvent` DB read in the Writer** — no coupling to the evidence store (the Adapter stays the only seam).

## 10. PolicyVersion validation — **REAL OPEN (firsthand-confirmed)**
The Writer must validate `policyVersionId` **exists** (`DerivationPolicyVersion.findUnique`) and reject if absent; **no current/latest/default lookup** (forbidden).
> **But firsthand: the Derivation Policy registry is EMPTY, and there is NO governed mapping from `claimType = "vendor-category"` to a `policyVersionId`.** `VENDOR_CATEGORY_POLICY_NAME` is only a code constant; no `DerivationPolicy`/`DerivationPolicyVersion` row is seeded, and nothing resolves the claimType to a version id. So **no valid `policyVersionId` exists to pin, and the Projection FK (RESTRICT) has nothing to reference.**
- **Consequence:** the pure Writer (W1) is fully designable and unit-testable *in isolation* (a test seeds a policy-version row; the Writer validates + rejects when absent). **But producing a REAL (non-test) projection is blocked** until (a) the `vendor-category@v1` policy identity is **registered** as a governed `DerivationPolicyVersion` row, and (b) a **governed `claimType → policyVersionId` resolution** is defined (this is the deferred "policy selection / policy registry" question, RATIFIED as deferred in Persistence Design §20 / Claim pre-impl §22).
- **This is an owner/governance decision — I did not invent a mapping.** It gates the Orchestrator/activation slice, **not** the W1 Writer build.

## 11. Unsupported-state handling (locked)
Deriver returns `supported | conflicting | insufficient | withdrawn`. Persistence rule: **insufficient / withdrawn = absence** (pre-impl v2 §5/§7).
> **Materializer contract:** `supported | conflicting` → **write/replace** the projection (1 or ≥2 candidates). `insufficient | withdrawn` → **delete the existing projection slot if present, create NO empty row.** Locked.

## 12. Candidate consistency (reject malformed; never silently fix)
Before write: candidate `propositionValue`s are unique within the result; each persisted candidate's `supportingRefs` is **non-empty**; each `supportingRefs ⊆ result evidence set` (§13); each `candidate.claimType == result.claimType`. Violation → **reject** (do not repair).

## 13. Evidence-set consistency (firsthand-grounded — SUBSET, not equality)
Firsthand from the Deriver: `evidenceSetIdentity.refs` = the **full** owner-decision evidence set for the subject (includes non-qualifying items — `not-submitted` / `rejected` / null-category / erased); `candidate.supportingRefs` = the **qualifying subset** for that value.
> **Invariant: each `candidate.supportingRefs ⊆ evidenceSetIdentity.refs`. Do NOT require `union(supportingRefs) == evidenceSetIdentity.refs`** — the Deriver does not guarantee it (the full set legitimately contains evidence that supports no candidate). Asserting equality would be inventing a guarantee the output does not make (§13 warning). Assert subset + non-empty-per-candidate only.

## 14. Writer purity boundary
Writer input = **validated materialization command**; output = `created | replaced | deleted | no-op`. It does **not** derive, normalize a vendor, select policy, read `VendorLearning`, or recommend.

## 15. Prisma transaction design
> **Interactive `$transaction`** (deterministic sequence): `findUnique` policy version → structural + tenant validation → conditional `delete` of the slot's Projection (cascade) → nested `create` of Projection + Candidates + EvidenceLinks (or `create` + `createMany`). Interactive is required (reads + conditional delete + validation gate); batch/`$transaction([])` cannot express the read+conditional; pure nested-write cannot do the pre-delete. **No code written here.**

## 16. Concurrency
Two materializers, same slot: the Projection `@@unique` + row locks **serialize** them; at most one projection per slot. Combined with §7's pre-commit revalidation, a **stale write cannot persist** and lost-update is prevented (the newer derivation re-writes). Contract holds even though **full distributed/advisory locking is deferred**; a per-slot `pg_advisory_xact_lock` is an option if churn is observed.

## 17. Failure model → final DB state
| failure | final state |
|---|---|
| invalid tenant ref | rejected pre-transaction; slot unchanged |
| policy version missing | rejected pre-transaction (FK/validation); slot unchanged |
| malformed candidate | rejected pre-transaction; slot unchanged |
| failure after old-projection delete | **transaction rolls back → old projection intact** |
| failure mid candidate inserts | rollback → old projection intact |
| failure mid EvidenceLink inserts | rollback → old projection intact |
| same result replay | idempotent → identical state (or no-op) |
| concurrent same-slot writes | serialized by unique + locks; identical (idempotent) or one retries |
| stale-evidence result | **rejected by §7 pre-commit revalidation → not written** |
| insufficient replacing supported | existing slot **deleted**; no empty row |
> No scenario yields a partial candidate-set (atomic transaction).

## 18. Activation boundary
Even after the Writer exists: **do NOT wire it to `decideCategory`.** Activation stages stay **separate**: (1) writer exists, no consumer; (2) shadow materialization; (3) compare vs `VendorLearning`; (4) read-path decision. **Never merged.**

## 19. Shadow-mode future (compatibility, not now)
The design is shadow-ready: `ReviewEvent → Adapter → Deriver → Materializer` writes projections **without changing recommendation/read behavior** (decideCategory still reads `VendorLearning`). This is the first *possible* future activation — **not enabled here.**

## 20. VendorLearning boundary
**No** write / delete / backfill / dual-write to `VendorLearning`. A future shadow-comparison may **read** it, but not in the first Writer slice.

## 21. Observability / audit
The Writer returns/logs (logs are **not** authority): slot identity · `evidenceSetFingerprint` · #candidates · #evidence-links · `action = created|replaced|deleted|no-op`. **No new audit table in slice 1** (the projection itself + the canonical evidence are sufficient).

## 22. Security
Tenant `businessId` from **server/session context, never client payload**; no client-controlled `businessId`; no cross-tenant refs (rejected §8); no raw evidence copied (refs only). `subjectNormalizedKey` is a normalization of **already-stored** vendor names (`ReviewEvent.vendorFinal` / `VendorLearning.vendorName`) → **no new PII surface**; classified, no privacy redesign opened.

## 23. First writer slice
| **W1 · Persistence Writer only** | W2 · Orchestrator + Writer | W3 · Full shadow pipeline (+trigger) |
|---|---|---|
- **W1 (recommended):** a pure transactional Writer taking a **validated** `DerivedClaimResult` + target `businessId` → replaces/deletes the slot. Narrowest, unit-testable in isolation (test-seeded policy version), **inert** (no consumer). Does NOT require solving §10's registry OPEN to build/test (it validates + rejects).
- W2 adds Adapter+Deriver sequencing + the §7 stale guard (and surfaces the §10 registry prerequisite for real use). W3 adds triggering. **One slice at a time.**
> **Recommendation: W1 first.**

## 24. Implementation prerequisites
1. **(Gating for real projections, NOT for W1 build)** Governed **Derivation Policy registry**: register `vendor-category@v1` as a `DerivationPolicyVersion` row + define the governed **`claimType → policyVersionId` resolution** (§10). Owner/governance decision; deferred "policy selection".
2. W1 itself needs only: the merged Deriver output type + the Claim substrate (both present) + a test-seeded policy version.

## 25. Forbidden in the Writer slice (permanent)
No derive/normalize/policy-select/recommendation · no `VendorLearning` write/read · no `ReviewEvent` DB read (Adapter-only) · no confidence/score · no winner/current/latest/preferred · no client-controlled tenant · no cross-tenant ref · no raw-evidence copy · no `decideCategory` wiring · no new audit table · no Claim history.

## 26. Deferred items
Policy registry seeding + claimType→version resolution (§10, owner) · Orchestrator (W2) · trigger/shadow enablement (W3) · rebuild worker · read-path/`decideCategory` switch · VendorLearning backfill/compare · confidence formula · erasure runtime · RIA late-binding · recommendation layer · advisory-lock hardening · queried prod verification (Evidence Hardening).

---

## Verdict
The Materializer's first slice — **W1, a pure, narrow, transactional persistence Writer** (orchestration boundary **C**) — is **fully designed and ready to implement + unit-test in isolation**: atomic delete+insert replace, idempotent, tenant- and consistency-validated (subset invariant §13), state-correct (insufficient/withdrawn = delete), inert (no consumer, no `decideCategory` wiring). **However**, a firsthand-confirmed **real OPEN** gates any *real* (non-test) projection and is an owner/governance decision I must not invent: **the Derivation Policy registry is empty and there is no governed `claimType → policyVersionId` resolution** (§10/§24). W1 can be built and tested before that is resolved (it validates + rejects); the Orchestrator/activation cannot proceed to real writes until it is.

> **B — READY WITH OWNER DECISION.**
> *Owner decisions: (1) ratify orchestration boundary = C and first slice = W1; (2) resolve the Derivation Policy registry + `claimType → policyVersionId` resolution (the deferred policy-selection OPEN) before any real projection is written. W1 is implementable/testable in isolation immediately upon (1).*

---

*Materializer Pre-Implementation Design v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Claim pre-impl v2; Contract v1 governs. No code/schema/migration/SQL/write/branch/commit/PR; VendorLearning / ReviewEvent / Evidence Adapter / Memory Deriver / DerivationPolicy / Claim substrate / RIA / C0 / C1 unmodified and unactivated.*
