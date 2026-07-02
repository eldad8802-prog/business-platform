# Compliance Implementation Report — W9 (CI Enforcement · Phase 1)

**Wave:** W9 — turn the W0 enforcement mechanisms (jsx-a11y, gitleaks) into enforced parts of the dev process — conservatively. No new gate types; scope limited to the existing W0 mechanisms. Goal: **No New Debt**, not fix-all-existing-debt.
**Date:** 2026-07-03
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. What became enforceable
**jsx-a11y → enforced on CHANGED files (WP1 A-16).**
- `eslint.config.mjs` keeps jsx-a11y rules at **`warn`** (a full lint never fails → **legacy is grandfathered**, WP9 §10).
- New CI workflow **`.github/workflows/a11y-changed-files.yml`** + helper **`scripts/ci/check-jsx-a11y.mjs`**: on every PR it lints only the changed `.tsx/.jsx` files and **fails if any jsx-a11y rule fires** on them (scoped to `jsx-a11y/*`; other lint warnings are ignored). So **new/changed UI code MUST be accessible**, while unchanged legacy is never checked.
- **Verified locally (both directions):**
  - Positive — clean files (all W1–W8 touched files) → “No new jsx-a11y issues”, exit 0.
  - Negative — a file/report with a jsx-a11y issue → fails with a clear message, exit 1.

## 2. What stayed in `warn` / informational (deliberately)
- **jsx-a11y in the base config stays `warn`** — so a repo-wide lint of legacy never fails. Only the changed-files job is blocking.
- **gitleaks stays NON-BLOCKING** (`continue-on-error: true`, unchanged from W0). **Reason:** it has **no evidence of a clean run yet** — the branch is unpushed (never executed in CI) and gitleaks is not installed locally, so I cannot prove it passes on the repo. Flipping it to required now would risk an unexpected, unverified block. See §6 for the promotion path.

## 3. Documented exceptions required
- **`components/navigation/action-sheet.tsx`** had **2 pre-existing jsx-a11y warnings** on the dialog’s `stopPropagation` click handler (`no-noninteractive-element-interactions`, `click-events-have-key-events`). These are a legitimate pattern (the dialog manages Escape/focus; the click only stops backdrop-close). Added **one scoped, justified `eslint-disable`** — the documented-exception mechanism the enforcement relies on. This also makes every recently-touched file clean, so the new gate is green on current work.
- No other exceptions were needed (all W1–W8 files already pass).

## 4. Accessibility Primitives — how they’re enforced (task 4)
- **a11y OUTCOMES** (labels, roles, alt, aria, etc.) → **enforced by the jsx-a11y changed-files CI** (§1). This catches the concrete accessibility defects without false positives.
- **Primitive USAGE** ("this dialog should use `useAccessibleDialog`") → **NOT lint-enforced** — no reliable rule can detect "this ought to be a dialog/field" without false positives. It is enforced by **Code Review** (the PR template’s Accessibility Review, W0) + the module **README guide**. This is the honest boundary: lint enforces outcomes; review enforces the right primitive.

## 5. Grandfathering & unexpected blocks
- **Grandfathering preserved:** base config `warn`; only files changed in a PR are enforced; unchanged legacy is untouched. Touching a legacy file requires its jsx-a11y to be clean *for that file* (campsite rule, WP9 §10) — with the `eslint-disable` escape for intentional patterns.
- **Unexpected blocks:** none found. Every file touched across W1–W8 passes the new gate (verified). The only pre-existing warnings (action-sheet) were resolved with a documented exception.

## 6. Recommendation — can the gates be hardened later?
Yes, in this order, each gated on evidence:
1. **gitleaks → required:** push the branch, let the non-blocking gitleaks job run once; if clean, remove `continue-on-error` and mark it a required check (branch protection). *(Do not flip before an observed clean run.)*
2. **jsx-a11y changed-files → required check** (branch protection) once the workflow has run green on a few PRs.
3. **Later, opportunistically:** as legacy a11y debt shrinks, promote specific high-value jsx-a11y rules from `warn` to `error` in the base config (a broader, repo-wide gate). Not now — that would break legacy.
4. **Optional refinement:** move from changed-*file* to changed-*line* enforcement if touching warning-heavy legacy files becomes friction. Not needed today.

## 7. Verification (lint / typecheck / tests)
- Enforcement helper `scripts/ci/check-jsx-a11y.mjs` — positive (exit 0 on clean) and negative (exit 1 on a jsx-a11y issue) both verified locally.
- `components/navigation/action-sheet.tsx` — `eslint` now **0/0**.
- All W1–W8 touched files — **no jsx-a11y issues** (the gate is green on current work).
*Honest caveat:* the GitHub Actions workflow itself was not executed (the branch is unpushed / no CI run); its core (`eslint -f json` → `check-jsx-a11y.mjs`) is verified locally, but the end-to-end job (checkout + diff + `npm ci`) is verified by construction, not by a live run.

---

## Success Criterion — the one question
> *"Will all new code entering Dubiz from now be required to meet the constitution, without blocking continued work on existing code?"*

**Yes, for accessibility (Phase 1).** New/changed UI is required to pass jsx-a11y (blocking on changed files); legacy is grandfathered and never blocked. Secret-scanning is staged (non-blocking until an observed clean run, then promotable). The enforcement is **No New Debt**, exactly as scoped — and reversible/hardenable step by step per §6.

## Files touched (W9)
`.github/workflows/a11y-changed-files.yml` (new) · `scripts/ci/check-jsx-a11y.mjs` (new) · `components/navigation/action-sheet.tsx` (documented exception) · `docs/compliance-constitution-system-audit-v1.md` (G-7) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W9 commit follows.
