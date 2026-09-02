# Dubiz — Business Memory Orchestrator · Pre-Implementation Design v1

> **Status: PRE-IMPLEMENTATION DESIGN — NO ACTIVATION.** Read-only. Designs the first component that sequences **Evidence Adapter → Policy Resolver → Memory Deriver → Claim Writer** into one defined flow, while staying inert/unwired. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Materializer pre-impl v1; Contract v1 governs.
> **Baseline:** `origin/main 65b9ca1` (Adapter/Resolver/Deriver/Writer all merged, all inert, 0 production callers). Firsthand-revalidated.
> **Type:** a design. No code / schema / migration / SQL / write / branch / commit / PR.

---

## 1. Baseline (firsthand)
Four inert components exist on main, **0 production callers of any**:
- **Adapter:** `createReviewEventEvidenceReader().readOwnerDecisionEvidence(businessId, subject) → OwnerDecisionEvidenceSet{subject, items, identity}` + canonical `vendorSubject(businessId, vendorFinal)`.
- **Resolver:** `resolveVendorCategoryPolicyVersion(client) → { policyKey, versionLabel, policyId, policyVersionId }` (exact, binding, fail-closed).
- **Deriver:** `deriveVendorCategory(evidenceSet, policyVersionId, options?) → DerivedClaimResult`.
- **Writer:** `materializeClaim({ businessId, result }, client?) → MaterializationOutcome` (atomic replace, W-A validates policyVersion existence).
- **`EvidenceSetIdentity.fingerprint`** = `refs.map(r => \`${kind}:${businessId}:${recordId}\`).join("|")` — a **LOSSLESS delimited concatenation** of the ordered refs, **not a hash** → fingerprint equality ⟺ ref-set+ordering equality (injective). *(Decisive for the freshness model, §5.)*
- VendorLearning still the live runtime path; no shadow trigger, no Claim reader, no Orchestrator. **No REVALIDATION-REQUIRED.**

## 2. Orchestrator responsibility (contract)
> **For one trusted tenant + domain-local subject, resolve the explicitly governed policy version, read canonical owner-decision evidence, derive the claim result, verify evidence freshness, and only then invoke the narrow Writer.**

Owns **sequencing + freshness + governed-binding resolution** only. Does **not**: define derivation semantics · pick a winner · compute confidence · read/write/compare VendorLearning · change recommendation · choose "latest" policy · write canonical evidence.

## 3. Exact sequencing
```
1. validate trusted businessId + build/validate DomainLocalSubject (same tenant)
2. resolve policyVersionId := resolveVendorCategoryPolicyVersion()            // once, governed binding
3. evidenceA := readOwnerDecisionEvidence(businessId, subject)                // first read
4. resultA  := deriveVendorCategory(evidenceA, policyVersionId)              // pure
5. evidenceB := readOwnerDecisionEvidence(businessId, subject)               // second read (freshness)
6. if identity(evidenceA) != identity(evidenceB)  → STALE (S1/S2 — §6)
7. else materializeClaim({ businessId, result: resultA })                    // Writer
```
- **Resolver runs BEFORE the evidence read** and **once** (§8): the binding is static/immutable and independent of evidence; resolving early fails fast and keeps `policyVersionId` fixed across the derivation. (Placing it after the read would gain nothing and risk an inconsistent version between derive and write.)
- The **second read is of the evidence identity only** (the Adapter already returns it); it does not re-derive.

## 4. Double-read freshness contract
> **A derivation may be written only if the canonical evidence-set identity immediately before Writer invocation is identical to the identity used for derivation.**
Comparison is **identity-based**, never timestamp / `createdAt` / latest-event heuristic. This catches evidence that changed *during* derivation (steps 3→5).

## 5. What exactly is compared
The Adapter identity has `refs` · `ordering` · `fingerprint`.
| F1 full structural equality (refs+ordering) | F2 fingerprint only | **F3 refs+ordering canonical, fingerprint as aid** |
- Because the fingerprint is a **lossless injective concatenation** (§1), fingerprint equality **provably equals** refs+ordering equality — there is **no hash-collision risk**. So F2 and F3 are equivalent here.
- **Recommendation: F3** — treat `refs`+`ordering` as the truth and use `fingerprint` as the cheap equality check, so the design never *depends on* a digest being authoritative (even though this fingerprint happens to be lossless). Compare `ordering` too (guard against an ordering-rule change).

## 6. Stale-result behavior
| S1 abort & return `stale` | **S2 bounded internal retry (small N)** | S3 loop-until-stable (unsafe) |
- **S3 rejected** (unbounded).
- **Recommendation: S1 for the first slice** (simplest — the Orchestrator returns a typed `stale` outcome; the future trigger/caller decides whether to re-run). S2 (bounded N, e.g. 2–3) is an acceptable alternative that converges without bouncing to the caller. **Never infinite retry.** *(Owner decision, §Verdict.)*

## 7. Retry semantics (only if S2)
If bounded S2: fixed `maxAttempts` (small); retry **only** on `stale-evidence` (re-read+re-derive), **not** on DB/serialization errors; no generic retry; no backoff in v1. **The Writer itself never retries** (unchanged from IMPL-5A).

## 8. Policy-resolution freshness
Resolve **once**, up front. Justification: the binding is an **explicit static descriptor** (`VENDOR_CATEGORY_POLICY`) and the registry is **immutable append-only** (POLICY-2) — a version identity cannot change or vanish mid-flow (RESTRICT). So a mid-flow registry change cannot invalidate a resolved id. **No re-resolve, no current/latest logic.**

## 9. Policy ↔ Deriver consistency
The **Orchestrator owns governed binding resolution**: it resolves `VENDOR_CATEGORY_POLICY` → `policyVersionId` and passes that same id to the Deriver (`deriveVendorCategory(evidence, policyVersionId)`), which stamps it onto `result.policyVersionId`; the Writer then only **validates existence** of that id (W-A). **The public Orchestrator contract accepts NO arbitrary caller-supplied `policyVersionId`.**

## 10. Subject construction
Orchestrator input = **trusted `businessId`** + a raw vendor identity (e.g. `vendorFinal` string). It builds the `DomainLocalSubject` via the **canonical `vendorSubject(businessId, vendorFinal)`** (the same `normalizeVendorForLearning` the Adapter uses) — **no duplicated normalization**. The Adapter is then read with that subject.

## 11. Tenant boundary
`businessId` is **server-trusted** (never client-controlled). The subject is built same-tenant; the Adapter is read same-tenant; the Writer command carries the same tenant; the Writer re-validates tenant on every ref (IMPL-5A §6). Any mismatch → **fail before the Writer.**

## 12. Evidence-read scope
The Adapter exposes owner-decision evidence and engine-belief context via **separate** methods. For vendor-category v1 the Deriver consumes **owner-decision evidence ONLY** (`readOwnerDecisionEvidence`). **Do NOT feed engine-belief context "because it exists"** — it is non-authoritative and the Deriver does not use it.

## 13. Silence semantics (locked)
No evidence → Deriver `insufficient` → Writer **deletes the slot if present** (no empty root). The Orchestrator does **not** translate silence into approval / a previous known category / a VendorLearning fallback. Locked.

## 14. Conflict semantics (locked)
Conflict passes **end-to-end**: evidence → Deriver `conflicting` (candidate-set) → Writer persists **all candidates, no winner**. The Orchestrator does not decide — no majority/recency/winner.

## 15. Error taxonomy (typed, minimal — not a framework)
Distinct outcomes/errors: `invalid-tenant-or-subject` · `policy-resolution-failed` · `evidence-read-failed` · `stale-evidence` · `derivation-validation-failed` · `writer-validation-failed` · `writer-concurrency-or-db-error`. Not collapsed under a generic "failed"; no heavy framework.

## 16. Writer-concurrency interaction (the real next OPEN)
W1 allows **last-committer-wins** on an existing slot (IMPL-5A audit, READ COMMITTED). The double-read prevents writing a result derived from evidence that changed **during** derivation, **but** two Orchestrators A and B can *both* pass their freshness checks and *both* write → **the later committer wins** → a stale overwrite is still possible. **The double-read does NOT serialize concurrent same-slot Orchestrators.** A `compare-and-write` guard (conditional on the stored `evidenceSetFingerprint`) or a per-slot advisory lock **would** close it — **deferred, not auto-added** (§18/§27).

## 17. TOCTOU gap (must be stated)
Even single-threaded: `read A → derive → read B(=A) → [a new ReviewEvent C is appended] → Writer writes A`. The window between the **final read and the write** is not closed by the double-read. Consequence: a **transiently stale projection** can be written; it **self-corrects on the next derivation** (C triggers a later run that re-derives and overwrites). **The double-read does NOT guarantee linearizability** — it is best-effort.

## 18. Required freshness guarantee (the owner decision)
| **G1 best-effort (self-correcting)** | G2 strong no-stale-write | G3 monotonic projection |
|---|---|---|
| evidence stable at the final pre-write read; tiny TOCTOU window accepted; later reprojection corrects | needs a compare-and-write token / lock (Writer contract change) | older evidence-set can never overwrite a newer one (needs a monotonic watermark) |
- **G1 is sufficient for v1 and is recommended**, because the projection is a **rebuildable cache** (Contract §5) with **no reader yet** (inert) — a transient stale cache has **zero product impact** and self-corrects. G2/G3 buy strong consistency the current (readerless) system does not need, at the cost of a **Writer contract revision** (conditional write) or locking.
- **This is a genuine owner decision** (the owner elevated it): pick the correctness *target*. If **G1** → O1/O2 are ready with the existing contracts. If **G2/G3** → a Writer `compare-and-write` contract revision is a **prerequisite slice** before the Orchestrator.

## 19. Trigger model — still no activation
The Orchestrator implementation will be a **callable service with 0 callers** — no approve-hook, cron, queue, or route. Activation is a separate later stage.

## 20. Shadow compatibility
Shadow-ready: a future trigger `owner correction/approval → Orchestrator → Claim cache write`, while the product still reads `VendorLearning`. **No comparison inside the Orchestrator v1.**

## 21. VendorLearning boundary
The Orchestrator does **not** read / write / compare `VendorLearning`. Shadow comparison is a **separate** future consumer/stage.

## 22. Idempotency end-to-end
Same `subject + same evidence + same policy` → repeated Orchestrator invocation → **same logical Claim state** (Deriver deterministic + Writer replace-idempotent). Storage ids / `materializedAt` may differ — no byte-identity claimed.

## 23. Return contract
A small typed outcome: `{ outcome: "materialized" | "deleted" | "stale" | typed-error, evidenceFingerprint, policyIdentity: {policyKey, versionLabel, policyVersionId}, writerAction?: created|replaced|deleted|no-op }`. **No** recommendation / confidence / truth language.

## 24. Observability / security
Minimal tenant-safe logs: slot identity, `policyKey/versionLabel`, `evidenceFingerprint`, candidateCount, writer action, stale-abort. **`subjectNormalizedKey` is a normalized vendor name — business-sensitive**; already stored in `ReviewEvent`/`VendorLearning`, so no *new* PII store, but for **log hygiene** prefer a **hashed/truncated subject id** in logs rather than the raw vendor string (no privacy redesign opened). `businessId` from server context only.

## 25. Failure scenarios → behaviour
| scenario | Writer called? | final state | retry | outcome |
|---|---|---|---|---|
| policy missing | no | unchanged | no | `policy-resolution-failed` |
| no evidence | yes (delete) | slot deleted/absent | no | `deleted`/`no-op` |
| supported | yes | projection+1 | no | `materialized` |
| conflict | yes | projection+≥2 | no | `materialized` |
| evidence changes between read A/B | no | unchanged | S1: no / S2: bounded | `stale` (or re-run) |
| evidence changes after read B, before write | yes (stale) | stale projection | no | `materialized` (self-corrects next run) — TOCTOU |
| Resolver DB failure | no | unchanged | no | `policy-resolution-failed` |
| Adapter DB failure | no | unchanged | no | `evidence-read-failed` |
| Writer P2002 (concurrent empty-slot) | attempted | one wins | no | `writer-concurrency-or-db-error` |
| two Orchestrators same slot | both may write | last-committer-wins | no | both `materialized` (stale-overwrite possible) |
| repeated identical invocation | yes | identical | no | idempotent `materialized` |
| tenant mismatch | no | unchanged | no | `invalid-tenant-or-subject` |
| malformed evidence/result | no | unchanged | no | `derivation/writer-validation-failed` |

## 26. Candidate Orchestrator slices
| **O1 single-pass (stale=return, no retry)** | O2 bounded-retry (stale ⇒ re-run ≤N) | O3 strong-lock | O4 orchestrator+trigger |
- **O3** (locking/compare-and-write) = the G2 path — heavier, needs a Writer contract change; deferred.
- **O4** (trigger) = activation — explicitly out of scope now.
- **Recommendation: O1 first** (simplest, best-effort G1, existing contracts). O2 is the fallback if the owner wants in-Orchestrator convergence.

## 27. Implementation prerequisites
For **O1/O2 + G1**: **nothing new** — all four component contracts suffice as-is; no Adapter/Writer/schema/registry change. For **G2/G3**: a **Writer `compare-and-write` contract revision** (conditional replace on the stored fingerprint) or a per-slot advisory lock is a **prerequisite** — a separate slice, not part of the first Orchestrator.

## 28. STOP conditions
READ-ONLY. No code/schema/migration/SQL/write/branch/commit/PR. No component contract is modified. If implementation reveals that O1/G1 needs an Adapter/Writer contract change → **STOP — EXISTING COMPONENT CONTRACT NEEDS REVISION** and report before expanding.

---

## Verdict
The Orchestrator's first slice — **O1: single-pass `Resolver → read A → derive → read B → identity-compare → Writer`, stale ⇒ return** — is **fully designed and implementable with the existing four contracts, no changes**, preserving tenant safety, governed binding (Orchestrator owns resolution, Writer validates), owner-decision-evidence-only, silence=delete, conflict pass-through, and end-to-end idempotency. **However**, the freshness/concurrency question is a genuine, owner-elevated decision: the double-read gives **best-effort (G1)** freshness only — a residual TOCTOU window and concurrent same-slot last-committer-wins remain (inherited from W1), self-correcting because the projection is an inert rebuildable cache with no reader. Choosing **G2/G3 strong** consistency would require a **Writer compare-and-write contract revision first** (a separate slice), which is *not* justified while the cache has no reader.

> **B — READY WITH OWNER DECISION.**
> **Recommendation:** first slice **O1** + freshness target **G1** (best-effort, self-correcting) — implementable now with zero contract changes. **Owner decisions:** (1) freshness target **G1** vs **G2/G3**; (2) stale handling **S1** vs **bounded S2**; (3) first slice **O1** vs **O2**. If G1 → O1/O2 ready. If G2/G3 → a Writer compare-and-write revision precedes the Orchestrator.

---

*Orchestrator Pre-Implementation Design v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Materializer pre-impl v1; Contract v1 governs. No code/schema/migration/SQL/write; Adapter / Resolver / Deriver / Writer / VendorLearning / RIA / C0 / C1 unmodified and unactivated.*
