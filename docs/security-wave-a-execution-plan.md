# Security Wave A — Execution Plan (Status / Tracking)

> **Document type:** Execution / Tracking / Status **only**, for Wave A (Perimeter & Guardrails).
> **This is NOT** a design, architecture, threat-model, Decision-Package, DoD, or policy document.
> Design, rationale, gap identifiers, phase definitions, and Definition-of-Done live in
> `docs/security-master-plan-v1.md` (strategic) and the existing governance docs
> (`docs/security-gap-matrix.md`, `docs/security-wave-1-execution-plan.md`). Nothing new is
> designed or decided here — this file records task status, PRs, evidence, and remaining work.
>
> **Base:** origin/main · **Last updated:** 2026-08-11.

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
- T5 — `/api/learning` cross-tenant closure — ⏳ PENDING
- T4b — Remove unused `bcryptjs` — ⏳ PENDING
- T1 — Static security headers — ⏳ PENDING
- T2 — CSP (report-only) — ⏳ PENDING
- T6 — `POST /api/business` gate — ⏳ PENDING
- T7 — Billing DTO output filtering — ⏳ PENDING
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
- **Next task:** T5 (`/api/learning` cross-tenant closure). *(T4a resolved — see "T4a — Dependabot (status)" above: Detection-Only; automated updates rejected by evidence.)*
- **Pending:** all tasks listed under "Pending" above.
- **Deferred follow-ups (tracking only — noted during Wave A execution, not new work items):**
  - Workflow doc-drift: `release-ci-verify.yml` still describes `release/verify` as non-blocking, though T3b made it a required check — DEFERRED.
  - `allow_merge_commit=true` coexists with enforced linear history (merge-commit option non-functional) — DEFERRED cleanup.
  - Secret-scanning Alert #1 left **OPEN** for future alert triage.
