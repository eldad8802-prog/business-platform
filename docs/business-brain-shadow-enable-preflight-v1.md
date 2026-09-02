# Dubiz — Business Memory Shadow Enable · Production Preflight v1

> **Status: PRE-ENABLE / NO ENV MUTATION.** Read-only audit of whether the first Production enable of Business Memory Shadow is safe, and exactly what must happen immediately after enable to prove it works without affecting the product. **No env var is changed, no event is executed, no enable is performed.**
> **Baseline:** `origin/main 38f70cf` (SHADOW-2 `6ec8dde` merged; `#237`/`#238` after it are docs/records salvage only). Firsthand-revalidated.

---

## 1. Baseline (firsthand)
- SHADOW-2 merged (`6ec8dde`); the two later commits (`#237`, `#238`) touch **no** `.ts`/approval/BM/prisma files (docs/records salvage). No REVALIDATION-REQUIRED.
- Wiring unchanged: post-`recordReviewEvent`-acknowledgement, kill switch `BUSINESS_MEMORY_SHADOW`, fail-closed default, **no Claim read path**, VendorLearning still the product behavior, no comparison/read-switch.

## 2. Production deployment
- `promaxgroup.co.il/` = **200**, `/api/health` = **200** (non-mutating; no ReviewEvent created).
- Main auto-deploys via Vercel; SHADOW-2 code is on main. **Evidence tier: deductive** — I cannot query the live Vercel deployment SHA (project not linked, §3), so "SHADOW-2 code is live" is inferred from `main` + healthy app, not queried.

## 3. Production flag state — **could NOT be firsthand-verified**
- `vercel` CLI is available + authenticated, **but the codebase is NOT linked to a Vercel project** (`vercel env ls` → "isn’t linked … run vercel link"). Linking requires owner-provided team/project IDs and writes `.vercel/` config — **out of scope for this read-only preflight**.
- Therefore I **cannot** firsthand confirm whether `BUSINESS_MEMORY_SHADOW` exists, in which scope (Production/Preview/Development), or with which value. **Evidence tier: deductive** — I did not set it; SHADOW-2 introduced the flag name for the first time; absent ⇒ OFF by the fail-closed parser.
> **§3 Hard requirement UNMET on my side:** "no ambiguity about which Production scope we're about to change" cannot be certified by me. It must be resolved **by the owner in the Vercel dashboard** (confirm the var's scope) or by linking the project with owner-provided IDs.

## 4. Production substrate readiness
Applied to Production (`neondb @ ep-flat-brook`) via gated release-migrate runs (firsthand from run logs):
- `20260817120000_add_derivation_policy_substrate` + `20260815120000_add_ria_policy_lineage` (run 31979044047).
- `20260817130000_add_billing_signature_data_url` + `20260818120000_add_derived_claim_substrate` (run 32085289373).
- `20260818130000_bootstrap_vendor_category_policy_v1` (run 32165870091 — POLICY-DEPLOY-1).
- `20260818140000_add_signed_pdf_artifact` (run on `756973a`, 2026-08-19T01:28, applied + post-status).
So Production holds: `DerivationPolicy`/`DerivationPolicyVersion` (+ the `key` revision + `vendor-category/v1` bootstrap) and `DerivedClaimProjection`/`Candidate`/`EvidenceLink`. **Evidence tier: migration-log/deductive** (not a live SELECT of the tables/rows — I did **not** upgrade this to queried).

## 5. Pending-migration audit → **PRODUCTION SCHEMA READY**
Last successful Production release-migrate = `756973a` (2026-08-19T01:28), which applied `20260818140000` and reached post-status. **Migrations in current main NOT at `756973a` = EMPTY.** So there is **no pending migration**, and SHADOW-2 added none. Shadow enable is **not** masking any schema drift; approval/BM code does not depend on an unapplied migration. ✓ (No STOP.)

## 6. Canonical policy readiness
The Resolver resolves `vendor-category/v1` by `DerivationPolicy.findUnique({ key })` → `DerivationPolicyVersion.findUnique({ policyId_version })` — **no numeric hardcoded id, no findFirst/latest/current**. The `vendor-category/v1` rows were applied by POLICY-DEPLOY-1. **Evidence tier: deductive** (from POLICY-DEPLOY-1's successful INSERT migration; no live SELECT path — §11).

## 7. First-enable strategy
| E1 · global enable for all eligible approvals | **E2 · controlled first execution (global flag, controlled event/window)** |
- There is **no tenant-level flag** — `BUSINESS_MEMORY_SHADOW=true` is **global**: while ON, **every** eligible approval triggers the shadow.
- **§17 Vercel semantics (must verify firsthand before enable — I could not, project not linked):** Vercel env vars are bound at deploy time; changing `BUSINESS_MEMORY_SHADOW` typically **requires a redeploy** to affect the running Production deployment. So "enable → one event → disable" = **enable-redeploy → (ON window) → disable-redeploy** — **two redeploys**, and during the ON window *all* eligible approvals in the whole tenant base run the shadow.
> **Recommendation: E2 via a QA-safe tenant + a short ON window**, because a truly single controlled event is only achievable if no other eligible approvals occur during the ON window — i.e., a QA-safe/owned tenant and a deliberately quiet window. (No rollout framework is built.)

## 8. First real event requirements
A QA-safe first event needs: an owned/QA-safe tenant (not a random real customer), a document approval that harms no customer data, a clear `vendorFinal`, a clear category owner-decision, and an expected `ReviewEvent`. **I have no confirmed QA-safe Production tenant/document, and I must not create one in preflight.** → **Owner must designate the QA-safe tenant + event.**

## 9. What first success means
First execution = success **only if**: the approval itself succeeds as before · `ReviewEvent` persisted · shadow attempted · Orchestrator outcome not an unexplained failure · **if materialized:** a Derived Claim written, policy = `vendor-category/v1`, correct tenant, candidate(s) consistent with evidence · no product reads the Claim · VendorLearning behavior unchanged. **`stale` is a valid outcome but does not by itself prove end-to-end materialization.**

## 10. Evidence to collect immediately after first execution
approval HTTP result · ReviewEvent persistence signal (the acknowledgement boolean / a row) · shadow log outcome + stage · policy identity · Writer action · candidate count · Derived Claim rows *if a read-only path exists* (§11) · app health · confirmation `decideCategory` untouched. **No raw vendor/evidence in the report.**

## 11. Live Claim verification path — **NOT available (gap)**
`prod-readonly-evidence.yml` is still **hardcoded** to `ops/evidence/cardcom-e2e-evidence.sql` with `workflow_dispatch: {}` (no inputs). There is **no** approved read-only path to `SELECT` the `DerivedClaim*` rows for a subject without a **repo mutation** (adding an evidence SQL + a workflow to run it). → **Queried proof that the Writer actually wrote the first Claim is unavailable**; only **deductive-from-logs** (`outcome=materialized`) proof is possible. A queried-verification evidence artifact would be a **separate additive task** — recommended as a hardening, and arguably a prerequisite if the owner requires queried proof.

## 12. Logging readiness — **owner-side (gap for me)**
The shadow logs opaque operational fields (businessId · outcome · stage · policy · writerAction) with **no** raw vendor/evidence/payload. But reading Production runtime logs requires **Vercel dashboard/CLI access** (project not linked) — **I cannot observe them**; the **owner** must read them after execution.

## 13. Latency evidence plan
F1 is awaited → **flag ON increases approval response latency** (Resolver + 2 Adapter reads + Deriver + Writer transaction). Plan: observe the approval request duration / any timeout in the owner's Vercel logs during the ON window. No performance system; operational evidence from the request/logs suffices.

## 14. Kill conditions (set before enable)
Immediately `BUSINESS_MEMORY_SHADOW=false` (+ redeploy) and STOP if any of: approval status/body changes · approval fails due to shadow · repeated shadow exceptions · Prisma/DB errors from Claim writing · cross-tenant suspicion · unexpected VendorLearning behavior · unreasonable latency/timeout · any unexpected Claim reader/product effect. **No debugging while the flag is ON.**

## 15. Stale is not a kill by itself
A single `stale` is a valid G1 outcome — do **not** auto-disable on it. But `stale` on **every** execution suggests a trigger/concurrency issue → report.

## 16. Enable duration
**P1 (recommended first):** enable → one controlled eligible event (QA-safe tenant) → verify → disable. P2: time-boxed/several events. P3: permanent. P1's feasibility depends on §17 redeploy semantics + a quiet QA-safe window.

## 17. Vercel semantics — **must be firsthand-verified before enable (I could not)**
Because the project isn't linked, I could not confirm: whether changing `BUSINESS_MEMORY_SHADOW` affects the **running** deployment or needs a **redeploy**; whether disabling also needs a redeploy; how many deployments P1 actually entails. **Assume a redeploy is required (do not assume hot env).** The owner must confirm this in the Vercel project before enable.

## 18. Rollback mechanics
Disable = set `BUSINESS_MEMORY_SHADOW=false` (or remove) **+ redeploy if required** → shadow dark again; verify via logs/next-approval. **Claims already written stay** (disposable, not product-readable, no cleanup required). No canonical-evidence/VendorLearning rollback.

## 19. No comparison yet
SHADOW-ENABLE-1 excludes VendorLearning comparison / agreement metrics / read switch / recommendation changes. Sole goal: **prove real canonical evidence can safely produce a real Derived Claim in Production.**

## 20. No backfill
No historical replay — only one **new** event/window after enable.

## 21. Approval-route safety recheck (firsthand)
`runShadowMaterialization` wraps its **entire** body in `try/catch`, and the catch's observability is itself wrapped in `try/catch` → **it can never throw to the route**. No accidental throw after catch, no promise-rejection leakage, no unsafe log serialization, no divergent response branch. The route's approval status/body is unchanged. ✓

## 22. Exact enable action — DESCRIBED, NOT EXECUTED
When approved, the owner (I must not touch prod env) would: in the **Vercel project → Settings → Environment Variables**, set `BUSINESS_MEMORY_SHADOW = true` in the **Production** scope, then **redeploy Production** (per §17), identify the new Production deployment, perform **one** approval on the QA-safe tenant, collect §10 evidence, then set the var back to `false`/remove and **redeploy** to return dark. **No action is taken here.**

## 23–24. Verdict + (conditional) runbook
The **code, wiring, schema, substrate, and policy are ready and safe** (dark, fail-closed, isolated, no pending migration, no product reader). What is **not** in place is the **operational verification/control layer**, and critically none of it is verifiable **from my side** (Vercel project unlinked): (a) firsthand flag-scope verification (§3 hard requirement), (b) a queried Claim-verification path (§11), (c) observable Production logs (§12), (d) a designated QA-safe controlled event (§8). These are owner-side/operational, not code defects.

> **C — NOT READY** *(for a fully-verified enable I can certify)* — **conditionally A/B once the owner closes the operational gaps.**
> The enable is **safe to perform**, but it cannot yet be **verified end-to-end** under this preflight because the verification/control instruments (Vercel scope check, queried Claim proof, log access, QA-safe event) are unavailable to me. It reaches **A** when the owner: (1) confirms `BUSINESS_MEMORY_SHADOW`'s Production scope in the Vercel dashboard; (2) confirms Vercel env→redeploy semantics; (3) designates a QA-safe tenant/event; (4) either accepts deductive-from-logs Claim proof **or** authorizes a queried-verification evidence artifact (separate additive task); (5) has Vercel log access for post-execution evidence.

### Conditional Enable Runbook (describe-only — DO NOT EXECUTE)
1. **Verify scope:** owner confirms `BUSINESS_MEMORY_SHADOW` is absent/false and will be set in **Production** scope only.
2. **Set + redeploy:** set `BUSINESS_MEMORY_SHADOW=true` (Production), redeploy Production; note the new deployment id.
3. **Controlled event:** perform exactly one approval on the QA-safe tenant with a clear `vendorFinal` + category.
4. **Collect evidence (§10):** approval 200; shadow log `outcome=materialized` (+ policy `vendor-category@v1`, tenant, candidateCount, writerAction); (optional) queried `DerivedClaim*` rows via the authorized read-only artifact; app health; `decideCategory` unchanged.
5. **Kill conditions (§14):** if any trip → `=false` + redeploy → STOP.
6. **Disable:** set `=false`/remove + redeploy → confirm dark (next approval logs no shadow, or flag off).
7. **Rollback note:** written Claims remain, disposable; no cleanup.

## Repository / environment mutation status
**None.** No env var changed, no Vercel link created, no event executed, no code/schema/migration. This document is the only artifact (untracked design doc).

---

*Shadow Enable Preflight v1 · READ-ONLY / NO ENV MUTATION. No production trigger/env/flag change; approval flow, VendorLearning, decideCategory, and Business Memory components unmodified and un-enabled.*
