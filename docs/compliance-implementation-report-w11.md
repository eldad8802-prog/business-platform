# Compliance Implementation Report — W11 (Review Remediation)

**Wave:** W11 — remediate the 3 material findings from the holistic branch review ([compliance-branch-review-report-v1.md](compliance-branch-review-report-v1.md)) before merge. Bounded; no new capability.
**Date:** 2026-07-03
**Branch:** `chore/compliance-foundation-w0` (draft PR #54).

---

## 1. What the review found → what W11 fixed
| # | Review finding | Fix |
|---|----------------|-----|
| 1 | **SEC-24 verify tests not wired into CI** — the "caught in CI" claim was aspirational (`release-ci-verify` runs only prisma-validate/lint/build). | New workflow **`.github/workflows/compliance-verify.yml`** runs `verify:documents-sec24` + `verify:whatsapp-webhook-pr4` as **blocking** checks on push/PR. The SEC-24 gate is now real. |
| 3 | **`a11y-changed-files.yml` gate integrity** — `eslint … \|\| true` could let an ESLint crash pass with empty JSON; unquoted `$CHANGED` broke on spaces. | Hardened: NUL-delimited file list (`git diff -z` + `mapfile -d ''`, spaces-safe), **explicit ESLint exit-code handling** (exit ≥2 = crash → fail), and `check-jsx-a11y.mjs` now **rejects empty/non-array JSON** (exit 2) instead of passing blind. Edge-tested locally (empty→2, clean→0, issue→1). |
| 2 | **`movement-modal.tsx` duplicated `useAccessibleDialog`** and lacked `inert`/scroll-lock. | **Migrated to the primitive** — removed the hand-rolled focus-trap, Escape effect, focus-in/restore effect, and refs (**net −63 lines**, +15/−78). It now **gains `inert` + scroll-lock**, so it is as accessible as every other modal. |

**Ride-alongs (cheap, from the minors):**
- **#4** — the hook's returned `dialogRef` is now **actually used** (movement-modal focuses the invalid field via it on validation error), so it's no longer dead surface.
- **#5** — documented the hook's Escape `stopPropagation` intent (a comment).
- Added a small, reusable primitive option **`initialFocusId`** so a dialog can focus a specific field on open (movement-modal focuses the quantity field) — preserving W1 behavior while removing the hand-rolled effect. `DocumentFilePreviewOverlay` is unaffected (option is optional).

## 2. Behavior preservation (movement-modal)
The migration is a11y-infrastructure only: validation logic, `createInventoryMovement` call, form reset, error handling, the A-15 field wiring (`aria-required/invalid/describedby`, `role="alert"`), and the `loading`-gated dismissal are all unchanged. Focus-on-open still lands on the quantity field (`initialFocusId`); focus-on-validation-error still targets it (via the hook's `dialogRef`). Verified: `eslint` 0/0, `tsc` clean.

## 3. Verification (local)
- `npm run verify:documents-sec24` — **PASS**; `npm run verify:whatsapp-webhook-pr4` — **PASS** (unaffected by the hook/movement-modal changes).
- `check-jsx-a11y.mjs` hardening — empty JSON → exit 2; clean → 0; jsx-a11y issue → 1 (all verified).
- Migrated files pass the jsx-a11y enforcement logic (clean).
- `eslint` 0/0 and `tsc` no type errors on `movement-modal.tsx` + `use-accessible-dialog.ts`.

## 4. Verification (real CI)
*(Filled after the W11 push updates PR #54.)*
- `compliance-verify` (NEW) — must run the two verify tests green in real CI (validates fix #1 end-to-end).
- `a11y-changed-files` (hardened) — must stay green on the changed files.
- `secret-scan` (gitleaks) — must stay clean.
- `release-ci-verify` — build stays green.

## 5. Findings NOT changed (with rationale)
- **#6** README→inventory `useModalDismiss` reference — accurate guidance; left as-is.
- **#7** nullable `analysis` return — verified callers handle null (tsc-clean); no change needed.
- **#8** structural (source-contract) SEC-24 tests for upload/gmail — acceptable given non-injectable routes; behavioural coverage exists for WhatsApp. A future injectable-seam refactor is optional.
- **#9** gitleaks `continue-on-error` promotion note — the promotion (remove it + mark Required) is the owner's next step after this review, tracked in the review report §5 and W10 §6.
- **#10** `security.txt` temporary contact — self-documented; replaced when a dedicated channel opens.

---

## Success Criterion
> The holistic review's 3 material findings are closed so the branch's enforcement claims are **actually true** and it ships no duplicate/less-accessible dialog.

**Met.** SEC-24 now runs in CI; the a11y gate can't silently pass on an ESLint crash; and `movement-modal` uses the shared primitive (smaller + more accessible). After the CI re-run confirms green, the branch is clean for the owner's merge + branch-protection promotion.

## Files touched (W11)
`.github/workflows/compliance-verify.yml` (new) · `.github/workflows/a11y-changed-files.yml` (hardened) · `scripts/ci/check-jsx-a11y.mjs` (hardened) · `components/ui/accessibility/use-accessible-dialog.ts` (`initialFocusId` + doc) · `components/inventory/movement-modal.tsx` (migrated, −63 lines) · `docs/compliance-branch-review-report-v1.md` (the review) · this report.
