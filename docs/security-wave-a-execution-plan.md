# Security Wave A — Execution Plan (Status / Tracking)

> **Document type:** Execution / Tracking / Status **only**, for Wave A (Perimeter & Guardrails).
> **This is NOT** a design, architecture, threat-model, Decision-Package, DoD, or policy document.
> Design, rationale, gap identifiers, phase definitions, and Definition-of-Done live in
> `docs/security-master-plan-v1.md` (strategic) and the existing governance docs
> (`docs/security-gap-matrix.md`, `docs/security-wave-1-execution-plan.md`). Nothing new is
> designed or decided here — this file records task status, PRs, evidence, and remaining work.
>
> **Base:** origin/main · **Last updated:** 2026-08-14.

## Purpose
Track the execution and verification status of the Wave A tasks (repository guardrails +
targeted low-cost, low-regression perimeter closures).

## Scope boundaries
- **In scope:** the Wave A task list below.
- **Out of scope (tracked elsewhere, unchanged):** design & rationale, gap register, phase
  definitions, DoD, threat model, and future-wave recommendations → `docs/security-master-plan-v1.md`
  and the existing governance docs.

---

## Completed / Verified

| Task | Task | Status | PR / Merge SHA | Evidence | Verification |
|------|------|--------|----------------|----------|--------------|
| T3a | CODEOWNERS | ✅ **COMPLETED** | PR #161 · `24ab3f1` | `.github/CODEOWNERS` | GitHub CODEOWNERS validation `errors: []`; CI green; single-file merge |
| T3b | Branch Protection / Required Checks | ✅ **VERIFIED** | settings-only (no PR) | Classic branch protection on `main` | Read-back: PR required, `release/verify` required, `enforce_admins=false`, linear history, force-push + deletion blocked |
| T3c | Secret Scanning / Push Protection | ✅ **VERIFIED / CLOSED** | settings-only (no PR) | `security_and_analysis`: `secret_scanning=enabled`, `secret_scanning_push_protection=enabled` | Already active; verified via API (capabilities were pre-enabled). Verified, not implemented. |
| T5 | `/api/learning` cross-tenant closure (gap C-2) | ✅ **VERIFIED / CLOSED** | PR #182 · `a424193072aa348da7ab1bae0ad77f55a48e1f76` | `/api/learning` + `/api/feedback` removed; `PrePublishModal` feedback mechanism removed | See "T5 — `/api/learning` closure (status)" below |
| T4b | Remove unused `bcryptjs` dependency | ✅ **VERIFIED / CLOSED** | PR #186 · `65ca26dddfc3dceda1f3b61266fe0008d828bc56` | `bcryptjs` removed from `package.json` + `package-lock.json`; `bcrypt` / `@types/bcrypt` unchanged | See "T4b — `bcryptjs` removal (status)" below |
| T1 | Static security response headers (**subset** of gap H-3) | ✅ **VERIFIED / CLOSED** | PR #195 · `9e3313e5954d15dc8300c8406a1fa1507ed3dd77` | 4 static headers added to `next.config.ts`; **no CSP / Permissions-Policy / HSTS `preload`** | Production `curl -I` (promaxgroup.co.il, HTTP 200): 4 headers live, exact, single-occurrence; see "T1 — Static security headers (status)" below |
| T7 (subset — gap M-3) | Billing documents **LIST** `pdfStorageKey` removal (**subset** of task T7 / gap M-3) | ✅ **VERIFIED / CLOSED** (subset); **T7 / M-3 remain PARTIAL** | PR #198 · `d391eab1cd77d22bd3f12b6bf4979de15f7a89d4` | `pdfStorageKey` removed from `LIST_SELECT` in `app/api/billing/documents/route.ts`; `pdfHash` retained; response-boundary regression test added | Code on `main` (git show): key absent from `LIST_SELECT`, `pdfHash` present; regression test passes; Vercel both success; prod endpoint live+auth-gated (401). See "T7 / M-3 — Billing LIST `pdfStorageKey` removal (status)" below |
| T6 (gap H2) | Remove unsupported `POST /api/business` endpoint | ✅ **VERIFIED / CLOSED** (H2); **broader Business-Isolation gap remains PARTIAL** | PR #201 · `1107636237384dc0371d4c963ca9f7885978909a` | `app/api/business/route.ts` (POST-only) deleted; orphan-business creation surface removed | Production (promaxgroup.co.il, public): `GET`+`POST /api/business` → **404** (app 404 page, not SSO); sibling `/api/business/*` still present + auth-gated (401). See "T6 — `POST /api/business` removal (status)" below |

## T6 — `POST /api/business` removal (status)

| Fact | Value |
|------|-------|
| PR / Squash SHA | PR #201 · `1107636237384dc0371d4c963ca9f7885978909a` |
| Change | `app/api/business/route.ts` (POST-only) **deleted** — single-file, pure deletion (−39) |
| Threat class | Attack-Surface + Integrity + Availability (unbounded authenticated orphan-business creation; violates single-tenant Wave-1 model). **Not** Confidentiality / privilege-escalation |
| Design decision | Full removal (not `410`/`405` stub) — no published/versioned external API today; consistent with `/api/learning` removal (T5). Design decision for current architecture, **not** a new governance policy |
| Scope (exact) | **Only** `POST /api/business`. `register`/`login`, `Business.name` uniqueness, orphan cleanup, other `/api/business/*` routes **untouched** |
| In-repo compatibility | **VERIFIED** — 0 in-repo consumers / imports / references |
| External compatibility | **UNKNOWN** (documented, non-blocking) — grep proves in-repo absence, not external absence; **not** inflated to "has consumer" or "absent" |
| Production verification | `GET`+`POST /api/business` → **404** (app 404 page; no `_vercel_sso_nonce`, not an SSO/Preview wall). Siblings `/api/business/{profile,bot-hub,bot-settings,capabilities}` → **401** (present, auth-gated) |
| Build / route-manifest | `next build` exit 0; `/api/business` removed from manifest, 18 `/api/business/*` siblings intact |
| Vercel deploys (post-merge) | `business-platform-btrl` **success**; `business-platform` GitHub-check **canceled/superseded** (not a build failure) — production empirically verified live on the merge commit |
| Prisma schema / migration / config / workflow / CI change | **None** |
| Relationship to broader gap | H2 (**remove `POST /api/business`**) closed. **Business-Isolation gap (D2) remains OPEN**: RLS Phase 1, Extension+ALS, H1 (`ContentFeedback` tenant), H3 (dual-URL), H4/H5 — **not** done, **not** closed here |
| Status | **VERIFIED / CLOSED** (T6 / H2); broader Business-Isolation gap **PARTIAL** |

## T7 / M-3 — Billing LIST `pdfStorageKey` removal (status)

| Fact | Value |
|------|-------|
| PR / Squash SHA | PR #198 · `d391eab1cd77d22bd3f12b6bf4979de15f7a89d4` |
| Scope (exact) | **Only** `GET /api/billing/documents` **LIST** response — `pdfStorageKey` removed from `LIST_SELECT` |
| `pdfStorageKey` (internal R2 object-key) | **Removed** from the LIST response |
| `pdfHash` | **Retained** — intentionally out of this subset's scope (deliberate scope guard, not sensitive-by-default) |
| Diff scope | Exactly 2 files: `route.ts` (+8 / −2; `LIST_SELECT` exported for the test + line removed) and `list-response.regression.test.ts` (+98, new) |
| Out of scope (unchanged) | POST/create response · `billing-draft.service.ts` (`createBillingDraft` `include` all-scalars) · single-doc `GET /billing/documents/[id]` · any other endpoint exposing `pdfStorageKey`/`pdfHash` |
| Security value | pdfStorageKey = storage-topology recon/pivot value → removed. pdfHash = near-zero access/enumeration value → retained (no forced widening) |
| Regression test | Response-**shape** (projection through `LIST_SELECT`), not select-inspection: pdfStorageKey absent, pdfHash + central fields present. Passes on merged code |
| In-repo compatibility | **VERIFIED** — no in-repo consumer reads `pdfStorageKey` from this LIST response |
| External compatibility | **UNKNOWN** (documented, non-blocking) — grep proves in-repo absence, not external absence; not inflated to "has consumer" |
| Production response (authed) verification | **UNKNOWN** — endpoint is tenant-scoped + auth-gated (401 without session); outcome is certain-by-construction (code on `main` + Prisma-select semantics + regression test) but not empirically curled |
| Prisma schema / migration / config / workflow / CI change | **None** |
| Vercel deploys (post-merge) | **Both Success** |
| Status | **VERIFIED / CLOSED** (LIST-`pdfStorageKey` subset); **T7 / gap M-3 remain PARTIAL** |

## T5 — `/api/learning` closure (status)

| Fact | Value |
|------|-------|
| PR / Squash SHA | PR #182 · `a424193072aa348da7ab1bae0ad77f55a48e1f76` |
| `/api/learning` | **Removed** |
| `/api/feedback` | **Removed** |
| Cross-tenant read vector | **Removed** |
| Global unowned write source | **Removed** |
| `ContentFeedback` model | **Retained in schema only** — no active Reader/Writer |
| Data-retention / schema cleanup | **Deferred** — intentional, tracked as a separate future task |
| Prisma schema change | **None** |
| Migration | **None** |
| Vercel deploys (post-merge) | **Both Success** |
| Status | **VERIFIED / CLOSED** |

## T4b — `bcryptjs` removal (status)

| Fact | Value |
|------|-------|
| PR / Squash SHA | PR #186 · `65ca26dddfc3dceda1f3b61266fe0008d828bc56` |
| Driver | Dependency Hygiene (unused direct dependency) — **not** a Dependabot alert (0/52 open alerts mention bcrypt/bcryptjs) |
| `bcryptjs` | **Removed** from `package.json` + `package-lock.json` |
| `bcrypt` (native, `^6.0.0`) | **Unchanged** — remains the sole hashing library on the live auth path |
| `@types/bcrypt` | **Unchanged** |
| Auth code (`app/api/auth/*`) | **Unchanged** |
| Diff scope | Exactly 2 files; only `bcryptjs` records; no other dependency pin changed |
| Prisma schema / migration / config / workflow / CI change | **None** |
| Vercel deploys (post-merge) | **Both Success** |
| Status | **VERIFIED / CLOSED** |

## T1 — Static security headers (status)

| Fact | Value |
|------|-------|
| PR / Squash SHA | PR #195 · `9e3313e5954d15dc8300c8406a1fa1507ed3dd77` |
| Headers added (4, all routes) | `Strict-Transport-Security: max-age=63072000; includeSubDomains` · `X-Content-Type-Options: nosniff` · `Referrer-Policy: strict-origin-when-cross-origin` · `X-Frame-Options: SAMEORIGIN` |
| Excluded (out of T1 scope) | **No CSP** · **no Permissions-Policy** · **no HSTS `preload`** · no other header |
| Relationship to gap H-3 | **Partial** — H-3 (Master Plan) also covers **CSP**; T1 closes only the **static-headers subset**. **CSP remains open (T2); H-3 is NOT fully closed.** |
| Diff scope | Exactly `next.config.ts` (+22 / −0) |
| Production verification | `curl -I` on `promaxgroup.co.il` (`/` and `/login`, HTTP 200): all 4 headers live, exact values, single occurrence; no `preload` / CSP / Permissions-Policy / `DENY`. App headers separated from Vercel/Next platform headers. |
| Behaviour preservation | Camera/geo **VERIFIED** (diff adds no Permissions-Policy) · document-preview iframe + WhatsApp **verified-by-construction** (X-Frame-Options gates being-framed, not features); page delivery smoke passed |
| UNKNOWN (documented) | Live authenticated browser smoke of the four features not executed (no session/device); regression structurally precluded for the listed features |
| Prisma schema / migration / config / workflow / CI change | **None** |
| Vercel deploys (post-merge) | **Both Success** |
| Status | **VERIFIED / CLOSED** (T1); gap H-3 **partial** — CSP/T2 open |

## T4a — Dependabot (status)

| Aspect | Status |
|--------|--------|
| Dependabot Alerts (Detection) | ✅ **VERIFIED** — enabled; producing the canonical alert set |
| Automated / grouped Security Updates (pilot) | ❌ **REJECTED BY EVIDENCE** |
| Operating model | **Detection-Only + Manual Security Remediation** |
| Version Updates automation | **NOT APPROVED / DEFERRED** |
| Auto-merge | Not used |

**Evidence / factual rationale:**
- Pilot config `.github/dependabot.yml` (closed allowlist: `js-yaml`, `@babel/core`; single security group) merged (PR #171), then removed (PR #178) → repository is **Detection-Only**; no `.github/dependabot.yml` in `main`.
- Enabling automated security updates produced **PR #177** whose diff **exceeded the approved allowlist scope**: `allow` scopes the *target* (js-yaml) but not the *diff* — the PR also modified **direct/runtime dependencies** (`next` 16.2.1 → 16.3.0, plus `sharp` and subtree). CI was green (build-safe) but **not security-scope clean**. PR #177 was **CLOSED / NOT MERGED** (scope violation, not CI failure).
- This is **not** a failure of Dependabot **Detection** — Alerts remain active, accurate, and valuable. Only the **Automated Security Updates** model was rejected, for insufficient diff-scope control.
- Current settings: Dependabot Alerts = **Enabled**; Dependabot Security Updates = **Disabled**.

## Pending (status only)

**Stage 1 — Headers & Targeted Closures**
- T2 — CSP (report-only) — ⏳ PENDING
  *(H-3 remaining scope: T1 closed the static-headers subset; CSP is the open remainder.)*
- T7 — Billing DTO output filtering — 🟡 **PARTIAL** — LIST-`pdfStorageKey` subset **CLOSED** (PR #198 / gap M-3). **Open remainder:** POST/create response (`billing-draft.service.ts` `include` all-scalars), single-doc `GET /billing/documents/[id]`, any other endpoint exposing `pdfStorageKey`/`pdfHash`, and `pdfHash` itself (deliberately retained).
- T8 — SVG upload hardening — ⏳ PENDING

**Stage 2 — Rate / Auth / Isolation-verify / Gateway**
- T9 — client-IP (XFF) fix — ⏳ PENDING
- T10 — Rate-limiting expansion — ⏳ PENDING
- T11 — Brute-force (policy + lockout) — ⏳ PENDING
- T12 — IDOR route sweep — ⏳ PENDING
- T13 — Deny-by-default middleware — ⏳ PENDING

**Operational (parallel, no PR)**
- OP1 — R2 bucket ACL verification — ⏳ PENDING

---

## Remaining work
- **Pending:** all tasks listed under "Pending" above.
- **Deferred follow-ups (tracking only — noted during Wave A execution, not new work items):**
  - Workflow doc-drift: `release-ci-verify.yml` still describes `release/verify` as non-blocking, though T3b made it a required check — DEFERRED.
  - `allow_merge_commit=true` coexists with enforced linear history (merge-commit option non-functional) — DEFERRED cleanup.
  - Secret-scanning Alert #1 left **OPEN** for future alert triage.
