# Compliance Branch — Holistic Review Report v1

**Status:** Final pre-merge review of `chore/compliance-foundation-w0` **as one system** (not wave-by-wave).
**Date:** 2026-07-03
**Method:** independent senior-engineer review of the **code/config** change surface (25 files, ~980 lines; docs/constitution frozen and out of scope), plus lead verification of the top findings against the branch. PR #54 (draft, not merged).
**Verdict:** **Mergeable in substance, but NOT clean — 2 gate-integrity gaps + 1 shipped debt item should be fixed before merge** (they make prior "enforcement/CI-gate" claims actually true). No correctness regressions.

---

## 1. Verdict
The branch is **consistent, maintainable, and correct**: the four accessibility primitives are well-abstracted, correctly named (`useX` hook / `getXProps` builder / `PascalCase` component), RTL-safe, and the SEC-24 durability fix is correct and — for the injectable WhatsApp path — genuinely tested. **But it is not debt-free**, and two of the enforcement mechanisms are weaker than the earlier reports implied. None is a correctness regression, so merge is not *blocked* on principle — but the top 3 should be remediated first so the "it runs in CI / it's enforced" claims hold.

## 2. Findings (prioritised)
| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | **Major** | **SEC-24 verify tests aren't wired into any CI workflow.** `package.json` defines `verify:documents-sec24` + `verify:whatsapp-webhook-pr4`, and the SEC-24 test bills itself "caught in CI", but **no workflow runs them** (`release-ci-verify` runs only prisma-validate/lint/build — confirmed). The regression guard is aspirational. | **Fix before merge** |
| 2 | **Major** | **`movement-modal.tsx` duplicates `useAccessibleDialog`** — byte-identical `FOCUSABLE_SELECTOR`, same focus-trap/Escape/focus-restore/backdrop logic the primitive now owns. It even **lacks `inert` + scroll-lock**, so it is *less* accessible than every modal that adopted the primitive. Shipped duplication the README forbids. | **Fix / fast-follow** |
| 3 | **Major** | **`a11y-changed-files.yml` gate integrity:** `npx eslint … > eslint-a11y.json \|\| true` can, if ESLint crashes, leave empty/partial JSON that either throws an opaque error or (edge) passes with zero enforcement. Unquoted `$CHANGED` also breaks on paths with spaces. | **Fix before merge** |
| 4 | Minor | `useAccessibleDialog` returns a bare `dialogRef` no consumer uses (dead surface; invites misuse). Inert loop has multi-dialog/stacking edge cases (closing dialog B un-inerts while A is open; order-dependent on portal mount). | Fast-follow (no stacked dialogs today) |
| 5 | Minor | Escape handler `stopPropagation()` in the hook, but not in `movement-modal`/`action-sheet` — undocumented inconsistency. | Document or align |
| 6 | Minor | README points at `useModalDismiss` (inventory-scoped) — accurate guidance, slightly leaky cross-layer reference. | Optional |
| 7 | Minor | `createDocumentFromOcrText` return widened to `analysis: null` — correct for SEC-24; audit callers for non-null assumptions (WhatsApp ignores it; verified tsc-clean). | Acknowledged (verified) |
| 8 | Minor | SEC-24 durability test is **structural (regex-over-source)** for upload/gmail/shared (WhatsApp has behavioural coverage). Brittle to refactors; low-assurance. Honestly self-documented. | Acknowledged |
| 9 | Minor | `gitleaks` `continue-on-error` promotion note has **no owner/expiry** ("temporary forever" risk). | Add owner+expiry (Exception Register) |
| 10 | Minor | `security.txt` temporary contact — no tracked replacement date. | Acknowledged |

## 3. The 8 dimensions
- **Consistency:** Good. Primitives follow documented conventions; RTL-safe throughout. Minor wrinkle: Escape `stopPropagation` differs across dialogs (#5).
- **Duplications:** One real one — `movement-modal` vs the dialog primitive (#2).
- **Quality:** High. `usePrefersReducedMotion` is textbook (`useSyncExternalStore` + SSR + no leak); `accessible-field` is clean/pure; object-URL + fetch cleanup correct in the preview overlay. Edge cases only in the inert loop (#4).
- **Maintainability:** Good. `eslint-disable`s are specific + justified (each cites the APG pattern + exact rule). README documents the platform.
- **Developer experience:** Strong — one import, one barrel, a 5-minute README; the right thing is the easy thing. (README accurate vs code.)
- **CI performance:** Validated in W10 — negligible (+<1min, parallel). Correctness gap in the a11y gate script (#3).
- **New technical debt:** #2 (duplicate dialog), #3 (gate can false-pass on crash), #1 (guard not wired), #8 (structural tests). Bounded and known.
- **Simplification:** Migrate `movement-modal` to the primitive (removes ~50 lines + 3 effects); drop the dead `dialogRef` return.

## 4. Positives
- `usePrefersReducedMotion` and `accessible-field` are exemplary.
- SEC-24 WhatsApp path: correct persist-before-OCR, survives OCR failure/empty as `needs_review`, never deletes on enrichment failure; storage/DB failures remain fatal with guarded cleanup — and behaviourally tested.
- Clean, atomic, linear commit history; no WIP leakage onto the branch; all `eslint-disable`s justified.

## 5. Recommendation
A small **remediation pass** before merge, addressing the three material items:
1. **Wire the SEC-24 verify tests into CI** (add `npm run verify:documents-sec24` + `verify:whatsapp-webhook-pr4` to a workflow) — makes the SEC-24 gate real.
2. **Harden `a11y-changed-files.yml`** — explicit ESLint exit-code handling + validate the JSON is a non-empty array before trusting a clean result.
3. **Migrate `movement-modal.tsx` to `useAccessibleDialog`** — removes the duplication and gains the missing `inert` + scroll-lock (also improves that modal's accessibility).

Minors #4/#5/#9 are cheap and can ride along; #6/#7/#8/#10 are acknowledged/optional. After remediation, re-run CI (all green) and then proceed to the merge + branch-protection promotion the owner already approved in principle.

## 6. Bottom line
The compliance branch is a genuine, high-quality platform layer — but two of its enforcement claims ("SEC-24 runs in CI", "a11y gate can't be bypassed") are not yet fully true, and it ships one duplicate/less-accessible dialog. Fixing those three (bounded, ~1 focused wave) makes the enforcement real and the branch clean, after which merge is warranted.
