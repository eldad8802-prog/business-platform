# Dubiz — Business Memory Shadow Activation · Pre-Implementation Design v1

> **Status: PRE-ACTIVATION DESIGN — NO WIRING.** Read-only design + audit of the FIRST activation of the Business Memory pipeline in **shadow mode** (produce real Derived Claims from owner decisions) with **zero product-visible or business-effective effect**. Implements Contract v1 + Architecture v1 + Persistence Design v1; Contract v1 governs.
> **Baseline:** `origin/main 756973a` (full pipeline Adapter→Resolver→Deriver→Writer→Orchestrator merged, inert, 0 callers). Firsthand-revalidated.
> **Type:** a design. No code / route change / schema / migration / queue / feature-flag / wiring.

---

## 1. Baseline & current approval/evidence flow (firsthand)
From `app/api/documents/[id]/approve/route.ts` (278 lines) + `correction-ledger.service.ts`:
- **No `$transaction` wraps the approval** — each write is an independent Prisma autocommit.
- Order on approve:
  1. (financial record create/update, if applicable)
  2. `if (!wasAlreadyApproved)` → **`prisma.vendorLearning.upsert`** — wrapped in `try/catch`, **best-effort, non-fatal** ("must NEVER fail the approval"), autocommit. *(usageCount++/confidence+=0.02, or create.)*
  3. **`prisma.document.update({ status: "approved" })`** → **APPROVAL COMMIT** (autocommit).
  4. **`await recordReviewEvent(...)`** → `prisma.reviewEvent.create` wrapped in `try/catch`, **best-effort, non-fatal** ("Never allow a ledger failure to affect the approve flow"), autocommit → **CANONICAL OWNER-DECISION EVIDENCE COMMIT**.
  5. `return Response.json({ success: true, ... })`.
- The whole body is in `try { … } catch { return 500 }`.
- **Existing best-effort/non-fatal pattern EXISTS** (both VendorLearning and recordReviewEvent already swallow their own errors). Orchestrator still 0 callers. **No REVALIDATION-REQUIRED.**

## 2. Shadow Mode — precise definition
> **Business Memory may read canonical evidence and write only to its own Derived Claim cache; no output affects any user-visible or business-effective behavior.**
- **Allowed:** read `ReviewEvent` via the Adapter · run Resolver/Deriver · write Derived Claims via the Writer · observe outcomes non-authoritatively.
- **Forbidden:** replace VendorLearning · change category recommendation/`decideCategory` · change approval/document state · change accounting/billing · any autonomous action.

## 3. Trigger candidates
| | canonical-evidence availability | commit ordering | failure isolation | duplicate-safety | complexity | time-to-first-shadow |
|---|---|---|---|---|---|---|
| T1 · right after `ReviewEvent.create` | evidence just committed | inside the ledger helper | mixes with ledger | ok (idempotent Writer) | low | fastest |
| **T2 · after the approval flow succeeds (after `recordReviewEvent`, before return)** | **committed** | **clean (post-commit)** | **own boundary** | **ok** | **low** | fast |
| T3 · async/background event after approval | committed | decoupled | strong | ok | **high (infra)** | medium |
| T4 · periodic rebuild job | committed | fully decoupled | strongest | ok | medium | slow (not live) |
- **T1 rejected** — placing the trigger inside/next to the ledger couples shadow to the ledger helper and muddies its single responsibility.
- **T2 recommended**: the approval status and the ReviewEvent are already **autocommitted** before this point (§1.3/§1.4), so the Adapter read sees durable evidence; it has its own failure boundary and doesn't touch the ledger.
> **Selected trigger point: T2 — immediately after `recordReviewEvent(...)`, before `return`, in its own best-effort block.**

## 4. Hard invariant — never before canonical-evidence commit
The ReviewEvent is written by `recordReviewEvent` via **autocommit**; after that `await` resolves, the evidence is **durably committed** (or best-effort-failed). The T2 trigger runs strictly **after** that await → it can only read committed evidence. There is **no shared transaction** to leak an uncommitted row. **Locked:** *Shadow materialization may only begin after the canonical owner-decision evidence is durably committed.* ✓ (T2 satisfies this by construction.)

## 5. Hard invariant — shadow failure must never fail approval
The status update (§1.3) and ReviewEvent (§1.4) commit **before** the shadow runs, and the shadow will be wrapped in **its own `try/catch` that never rethrows** (mirroring `recordReviewEvent`/`vendorLearning`). So a Resolver/Adapter/Deriver/stale/Writer failure **cannot** reach the outer `catch → 500` and cannot change the already-committed approval. **Locked:** *Shadow execution is observational/best-effort and must not become part of the success criteria of the existing approval flow.*

## 6. Failure-isolation model
| F1 · await shadow after approval, catch-all/log | F2 · fire-and-forget promise in-request | F3 · durable async job/queue | F4 · deferred batch |
- **F2 rejected**: Production is **Vercel serverless** — a detached promise after the response may be **killed before completion** (lifecycle not guaranteed). Unsafe.
- **F3** is stronger but adds queue infrastructure — heavier than a first shadow slice needs.
- **F1 (recommended)**: `try { await runVendorCategoryOrchestration(...) } catch { log }` — completes within the request, cannot throw out, mirrors the codebase's existing best-effort awaits. The **rebuild safety net** (§22) covers any miss.
> **Recommendation: F1** (owner may prefer F3 if the added latency, §7, is unacceptable).

## 7. Request-latency impact
F1 adds to the approval response: Resolver (2 findUnique) + Adapter read A (1 findMany) + Deriver (pure) + Adapter read B (1 findMany) + Writer (1 transaction: delete+nested create) ≈ **~5 DB round-trips**. The approval already performs several awaited writes; this is a **meaningful but tolerable** increase for a background cache write. If unacceptable → **F3 durable async** (deferred, owner decision). *(No guess: the shape is the merged code's real cost; the *acceptability* is the owner's call.)*

## 8. Canonical trigger payload
The trigger passes the **minimum**: `{ trusted businessId, vendorInput }` (the owner-final vendor string). It passes **NO** policyVersionId / DerivedClaimResult / evidence rows / category winner — the Orchestrator resolves/reads/derives itself (IMPL-6A §3/§8).

## 9. Duplicate-trigger semantics
Re-approval or retry may invoke the shadow again. The **Writer is replace-idempotent** and the Deriver is deterministic → a repeated invocation yields the **same logical Claim state**. **No dedup key / no idempotency table needed** — natural replay suffices in shadow.

## 10. Ordering of multiple corrections
Correction A then B → two shadow runs (possibly concurrent). O1's double-read + W1's last-committer-wins mean a **transient stale projection is possible** (§IMPL-6A). **Acceptable in shadow v1** because there is **no reader** and the next derivation/rebuild self-corrects. Locked as accepted.

## 11. Eligibility (silence ≠ approval)
Trigger **only when a usable subject exists** — i.e. the owner-final vendor (`body.extracted.vendorName` / the value fed to VendorLearning) is present and normalizes to a non-empty key. If absent → **skip** (no subject, no fabricated evidence). The Orchestrator still reads *all* the subject's ReviewEvents and derives; if none qualifies → Deriver `insufficient` → Writer deletes/no-op (harmless). **The shadow never creates evidence** — it only reads what the owner's approval already appended.

## 12. Existing VendorLearning write path (unchanged)
`approval → vendorLearning.upsert (best-effort) → document.update(status) → recordReviewEvent`. Shadow v1 **does not** disable / dual-write / reorder VendorLearning. `decideCategory` keeps reading `VendorLearning`. Product behavior is byte-for-byte unchanged.

## 13. Comparison question
| **S-A · materialize Claims only** | S-B · materialize + observational comparison vs VendorLearning |
> **Recommendation: S-A first.** Comparison is an additional observation layer not required to prove the pipeline runs. Proving "the pipeline can produce Claims from real approvals, safely and invisibly" is the goal of the first slice. Comparison is a clean follow-up.

## 14. If comparison were included (deferred)
S-B must be **read-only observational**: read VendorLearning + the Claim, emit `match | mismatch | conflicting | insufficient | vl-missing`. **Forbidden:** correct VendorLearning · choose a category · change a Claim · declare "Business Memory wins". *(Deferred to a later slice.)*

## 15. Metrics / evidence (minimal)
Per shadow run: `attempted` · outcome `materialized|deleted|no-op|stale|failed{stage}` · policy identity · candidateCount · **assertion: no user-facing change**. Future (S-B): agreement/conflict/insufficient rates. **No new analytics platform.**

## 16. Where shadow observability lives
Prefer **existing application logs** (structured, one line per run). The **Claims themselves are the projection** — not a shadow audit log. **No new DB audit/event table** unless a proven need emerges.

## 17. Privacy / logging
Shadow logs must **not** contain raw vendor name / raw evidence / document payload. Use `documentId` (if useful), `businessId` per logging policy, and an **opaque/fingerprint subject id** (hash the normalized key). No privacy redesign opened.

## 18. Approval transaction boundary (diagram)
```
BEFORE SHADOW (firsthand):
 request → auth → load document
   → [financial record create/update]
   → if(!wasAlreadyApproved) vendorLearning.upsert        (best-effort, non-fatal, autocommit)
   → document.update({status:"approved"})                 ── APPROVAL COMMIT (autocommit)
   → await recordReviewEvent(...)                          ── CANONICAL EVIDENCE COMMIT (best-effort, autocommit)
   → return 200

PROPOSED SHADOW (T2 / F1 / S-A):
   → await recordReviewEvent(...)                          ── CANONICAL EVIDENCE COMMIT
   ┌───────────────────────── FAILURE ISOLATION BOUNDARY ─────────────────────────┐
   │ if (SHADOW_FLAG && eligible(vendorFinal)) {                                   │
   │   try { await runVendorCategoryOrchestration({businessId, vendorInput}) }     │
   │   catch (e) { log(non-fatal) }   // never rethrows                            │
   │ }                                                                            │
   └──────────────────────────────────────────────────────────────────────────────┘
   → return 200   (unchanged status/body/latency-shape aside)
```
COMMIT BOUNDARY precedes the shadow; FAILURE ISOLATION BOUNDARY wraps it.

## 19. No circular dependency
Shadow flow: `Orchestrator → Adapter (reads ReviewEvent) → Deriver → Writer (writes DerivedClaim)`. It does **not** call approval, VendorLearning, or `decideCategory`. It is a **downstream leaf** (reading the just-committed ReviewEvent is a read of committed data, not a cycle). ✓

## 20. Stale outcome
If the Orchestrator returns `stale`, the shadow **does not retry** in v1 — `stale` is a valid observational outcome, logged, **never** an approval failure. (The next approval/rebuild re-derives.)

## 21. DB error
Writer P2002/deadlock/DB error → **logged/observed, approval unaffected, no retry storm** (F1's single catch; no loop). Manual/rebuild (§22) covers correction.

## 22. Rebuild as safety net
Claims are **rebuildable** → a **missed trigger / stale result / transient Writer failure** is correctable by a future rebuild job. This is an additional reason the first trigger can be **lightweight/best-effort** (F1) rather than durable/guaranteed.

## 23. Product-behavior proof (locked as impl/audit requirement)
Before/with activation, prove: `decideCategory` still reads `VendorLearning` exactly as before · **no code path reads Derived Claims** · no recommendation changed · approval response status/body unchanged. These become **required tests/audit** for the implementation slice.

## 24. Candidate activation slices
| **A1 · post-commit shadow materialization only (T2/F1/S-A)** | A2 · + observational comparison | A3 · durable async queue + materialize | A4 · batch/backfill only |
> **Recommendation: A1** — trigger the Orchestrator best-effort after `recordReviewEvent`, gated by a default-OFF kill switch. Smallest slice that proves live shadow materialization; A2/A3 are clean follow-ups.

## 25. Activation kill switch
> **Recommended: a single env flag (e.g. `BUSINESS_MEMORY_SHADOW`), default OFF**, checked at the trigger site. Lets the wiring deploy **dark** and be enabled deliberately (and disabled instantly). **No** tenant-level flags, **no** dynamic policy semantics. (Owner may waive it since the trigger isn't broadly connected — but default-OFF flag is the safer first wiring.)

## 26. Rollback
Disabling shadow = **flip the flag OFF / disconnect the trigger**. Claims are **disposable** (drop/ignore); **no canonical-evidence rollback, no VendorLearning rollback**. Clean and instant. Locked.

## 27. Success criteria
approval behavior unchanged · shadow failures non-blocking · Claims created only for **eligible** events · **no product reads Claims** · no VendorLearning mutation beyond existing · observable outcomes available · disabling shadow leaves the product unchanged.

## 28. Failure scenarios → behaviour
| scenario | approval result | VendorLearning | Claim result | logging | retry |
|---|---|---|---|---|---|
| ReviewEvent ok, shadow ok | success | unchanged | materialized/deleted | run logged | no |
| policy resolution fails | success | unchanged | none | `failed/policy-resolution` | no |
| Adapter read fails | success | unchanged | none | `failed/evidence-read-*` | no |
| Orchestrator stale | success | unchanged | none | `stale` | no |
| Writer DB fails | success | unchanged | none (or prior intact) | `failed/writer-error` | no |
| approval fails before ReviewEvent commit | 500 (as today) | as today | shadow **not reached** | — | no |
| duplicate trigger | success | unchanged | idempotent replace | logged | no |
| two quick corrections | success | unchanged | transient-stale possible, self-corrects | logged | no |
| missing vendor/category evidence | success | unchanged | insufficient → delete/no-op | logged | no |
| shadow disabled (flag OFF) | success | unchanged | **none** | none | no |
| deploy with old Claims present | success | unchanged | overwritten on next run | logged | no |
| VendorLearning write fails (independent) | success (as today) | already non-fatal | shadow still runs on evidence | logged | no |

## 29. Exact implementation prerequisites
The first shadow slice (A1) needs: **(a)** a change to `app/api/documents/[id]/approve/route.ts` (the T2 trigger block) — this is the **wiring** SHADOW-1 does not do now; **(b)** a **thin shadow helper** (eligibility + flag check + best-effort call + safe logging) under `lib/business-memory/`; **(c)** the env kill switch; **(d)** tests (product-behavior-unchanged + trigger best-effort). **No schema/migration.** **No component-contract change.** **No queue** (unless F3 is chosen).

## 30. STOP conditions
READ-ONLY. No production trigger / route change / schema / migration / queue / feature flag / Claim reader / VendorLearning read-switch. If the implementation reveals that A1 needs an approval-contract or Orchestrator change → **STOP — ORCHESTRATOR/APPROVAL CONTRACT NEEDS REVISION** and report.

---

## Verdict
The approval flow already uses an **autocommit + best-effort/non-fatal** pattern (VendorLearning, recordReviewEvent), giving a clean, safe insertion point: **T2 — after `recordReviewEvent`, before `return`, in its own never-rethrowing block**. The full pipeline is callable with `{businessId, vendorInput}`; Claims are a rebuildable, reader-less cache, so a best-effort (F1) trigger with the rebuild safety net is sufficient and safe on serverless. No schema, no component-contract change, no product read-path change. The design is complete. **What remains are genuine owner decisions** for a first *activation*: sync-await (F1) vs durable-async (F3); materialize-only (S-A/A1) vs +comparison (S-B/A2); kill-switch (recommended default-OFF env flag) yes/no.

> **B — READY WITH OWNER DECISION.**
> **Recommendation:** first slice **A1** (T2 trigger · F1 best-effort await · S-A materialize-only) behind a **default-OFF env kill switch**, deployed dark. **Owner decisions:** (1) **F1** vs **F3** (latency vs infra); (2) **S-A** vs **S-B** (comparison now or later); (3) kill-switch flag yes/no (recommended: yes, default OFF). No schema/contract change under any of these.

---

*Shadow Activation Pre-Implementation Design v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1; Contract v1 governs. No code/route/schema/migration/queue/flag/wiring; approval flow, VendorLearning, decideCategory, and the four pipeline components unmodified and unactivated.*
