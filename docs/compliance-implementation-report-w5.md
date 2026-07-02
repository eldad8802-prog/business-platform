# Compliance Implementation Report — W5 (Accessibility Platform Integration)

**Wave:** W5 — consolidate the three accessibility primitives into an official, discoverable part of the platform. **No new capability, no new primitive, no retrofit, no constitution change.**
**Date:** 2026-07-02
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. Consistency audit (the three primitives)
| Dimension | Before | After |
|-----------|--------|-------|
| **File structure** | 3 loose files in `components/ui/` | one folder **`components/ui/accessibility/`** with a barrel `index.ts` |
| **Discovery** | had to know 3 separate paths | **one import**: `@/components/ui/accessibility` |
| **API style** | hook / builder / component | unchanged — **consistent prop-bag-spread** for dialog + field; conventions now documented |
| **Naming** | `useAccessibleDialog` / `getAccessibleFieldProps` / `SkipLink` / `focusFirstInvalidField` | unchanged — the convention (`useX` hook, `getXProps` builder, `PascalCase` component) is now **written down** in the guide |
| **Documentation** | per-file JSDoc | per-file JSDoc **+ a single 5-minute developer guide** (README) |
| **Usage** | 3 different import lines | all consumers now import from the barrel |

## 2. What changed
- **Moved** (via `git mv`, history preserved) into `components/ui/accessibility/`:
  `use-accessible-dialog.ts`, `accessible-field.ts`, `skip-link.tsx`.
- **Added** `components/ui/accessibility/index.ts` — barrel exporting all three primitives + their types.
- **Added** `components/ui/accessibility/README.md` — the **Accessibility Platform Guide** (developer doc, *not* governance/compliance): when to use each, a basic example per primitive, a "what NOT to do" list, and the naming conventions.
- **Updated** the 3 existing consumers to import from `@/components/ui/accessibility` (create-item form, shell layout, document preview overlay).

## 3. Each primitive = WP1 only, no business logic (verified)
- `useAccessibleDialog` — focus trap/restore, aria-modal/label, Escape, inert, scroll-lock. **A11y only.** ✅
- `getAccessibleFieldProps` / `focusFirstInvalidField` — label/aria wiring + focus-first-invalid. **A11y only.** ✅
- `SkipLink` — skip anchor, visually-hidden-until-focus. **A11y only.** ✅
- No data, validation, or API logic lives in any of them.

## 4. No duplication (verified)
The three cover **distinct** concerns — dialog shell (A-11) vs field wiring (A-15) vs skip navigation (A-4) — with no overlapping logic. The only near-neighbour is the older Escape-only **`useModalDismiss`** (in `components/inventory/`), which `useAccessibleDialog` **supersedes**; the README tells developers not to use it for new dialogs. (Removing `useModalDismiss` + migrating its remaining consumers is a code-cleanup follow-up, not part of W5.)

## 5. Did business behavior stay identical?
**Yes.** W5 is a pure reorganisation + documentation: file moves, a barrel, a README, and import-path updates. No primitive logic changed; the 3 consumers behave exactly as before (verified: `eslint` 0/0 on the folder + all consumers; `tsc --noEmit` — the barrel resolves and there are **no type errors** in the module or its consumers).

## 6. Backlog v2 / follow-ups
- **No new Constitution Backlog v2 gap.** WP1 unchanged — **constitution frozen.**
- **Code-cleanup follow-up (not Backlog v2):** retire the Escape-only `useModalDismiss` once its consumers migrate to `useAccessibleDialog`.

## 7. Verification (lint / typecheck)
- `eslint` — **0/0** on `components/ui/accessibility/**` and all three updated consumers.
- `tsc --noEmit` — **no type errors** in the accessibility module or its consumers; the `@/components/ui/accessibility` barrel resolves. (Repo-wide pre-existing TS errors are in unrelated WIP files, not these.)

---

## Success Criterion — the one question
> *"Can a developer joining Dubiz today figure out, within five minutes, how to build an accessible dialog, field, and form using the existing infrastructure — without reading the whole constitution?"*

**Yes.** One folder (`components/ui/accessibility/`), one import (`@/components/ui/accessibility`), one 5-minute README with a when-to-use table, per-primitive examples, and a "what NOT to do" list. The developer never needs to open WP1 to get accessibility right. **The knowledge has moved from the constitution into the platform — one of the initiative's central goals.**

## Files touched (W5)
Moved: `components/ui/accessibility/{use-accessible-dialog.ts, accessible-field.ts, skip-link.tsx}` · New: `components/ui/accessibility/index.ts`, `components/ui/accessibility/README.md` · Import updates: `app/(shell)/inventory/items/create/page.tsx`, `app/(shell)/layout.tsx`, `components/documents/DocumentFilePreviewOverlay.tsx` · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W5 commit follows.
