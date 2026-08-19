# Compliance Implementation Report — W6 (Reduced Motion Primitive · A-8)

**Wave:** W6 — complete the core WP1 primitives with a shared reduced-motion utility (A-8), proven on one real animation.
**Date:** 2026-07-03
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. What was built
- **`components/ui/accessibility/use-prefers-reduced-motion.ts`**:
  - **`usePrefersReducedMotion(): boolean`** — returns whether the user set `prefers-reduced-motion: reduce`. Implemented with **`useSyncExternalStore`** (the React-recommended way to subscribe to a media query): SSR-safe (server snapshot `false`) and correct across live preference changes.
  - **`motionSafe(prefersReduced, animated, still)`** — a pure helper to pick the motion-appropriate value, keeping inline styles readable: `transition: motionSafe(reduced, "transform 240ms", "none")`.
- Exported from the accessibility barrel (`@/components/ui/accessibility`) and documented in the module README (when-to-use row + example).

## 2. Where it was applied (pilot — one place)
- **`components/navigation/action-sheet.tsx`** — the quick-actions bottom sheet (a real slide-up + fade interaction). Its three transitions (backdrop opacity, sheet `transform` slide, inner action-button micro-transition) are now gated with `motionSafe(reduced, …, "none")`. When the user prefers reduced motion, the sheet appears/disappears **instantly** with no slide/fade.

## 3. WP1 clauses covered
| Clause | Result |
|--------|--------|
| **A-8 reduced motion** | **Covered** — the primitive gates animations on `prefers-reduced-motion`; proven on a real animated component. Motion is never the only information channel here (the sheet's open/close is also conveyed by presence + focus). |

## 4. Did business behavior stay identical?
**Yes.** The change is purely motion-gating. The action-sheet's open/close **state machine is untouched** — critically, its unmount is driven by `setTimeout(TRANS_MS)` (not `onTransitionEnd`), so removing the transition does **not** break the enter/exit timing or leave the sheet mounted. Actions, routing (`go`), Escape, backdrop close, `inert`, and scroll-lock are unchanged. Diff = `+12 / −3`: import, hook call, three `motionSafe` gates, and two scoped-disable comments. Verified by `eslint` (primitive 0/0; action-sheet **0 errors**) and `tsc --noEmit` (no type errors). *Honest caveat:* not exercised in a live browser with the OS reduce-motion setting toggled; a quick manual check is recommended.

## 5. Findings & classification (honest)
- **Primitive lint issue → fixed properly (my code).** My first draft used `useState`+`useEffect`, which tripped `react-hooks/set-state-in-effect`. Rewritten with `useSyncExternalStore` — the canonical, lint-clean, SSR-safe approach. **No disable used.**
- **action-sheet pre-existing lint error → scoped disable (not mine).** The sheet's enter/exit **state machine** (`setIsPresent`/`setVisualOpen` in an effect) trips the same `react-hooks/set-state-in-effect` rule. This is **pre-existing** — W6 only added motion gating, not that effect. Handled with a scoped, justified `eslint-disable` block (same approach as W1). A codebase-wide `react-hooks` cleanup remains a general code-quality task (not a constitution matter).
- **2 remaining jsx-a11y warnings** on the action-sheet dialog's `stopPropagation` click handler are **pre-existing** and **warn-only** (non-blocking); left as-is (out of W6 scope).

## 6. Backlog v2?
**No new Constitution Backlog v2 gap.** A-8 was fully implementable as written; **WP1 unchanged — constitution frozen.** (The `react-hooks` / pre-existing jsx-a11y items are code quality, not constitution gaps.)

## 7. Verification (lint / typecheck)
- `eslint` — primitive **0/0**; action-sheet **0 errors** (2 pre-existing warnings).
- `tsc --noEmit` — **no type errors** in the primitive or the migrated component.

---

## Success Criterion — the one question
> *"Can a new Dubiz developer build a component with motion/animation that respects reduced motion without remembering all of A-8?"*

**Yes.** `const reduced = usePrefersReducedMotion();` + `motionSafe(reduced, animated, still)` — two calls, imported from the one accessibility barrel, documented in the 5-minute guide. The developer never opens WP1.

## Milestone — core WP1 now lives in the platform
| Primitive | Wave | WP1 |
|-----------|------|-----|
| `useAccessibleDialog` | W2 | A-11 dialogs |
| `accessible-field` (`getAccessibleFieldProps` + `focusFirstInvalidField`) | W3 | A-15 forms |
| `SkipLink` | W4 | A-4 skip navigation |
| `usePrefersReducedMotion` + `motionSafe` | W6 | A-8 reduced motion |

The core WP1 accessibility building blocks are now a consolidated, documented platform module (`components/ui/accessibility/`) — the knowledge has moved from the constitution into the platform.

## Files touched (W6)
`components/ui/accessibility/use-prefers-reduced-motion.ts` (new) · `components/ui/accessibility/index.ts` (barrel) · `components/ui/accessibility/README.md` (guide) · `components/navigation/action-sheet.tsx` (pilot) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W6 commit follows.
