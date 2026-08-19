# Compliance Implementation Report — W4 (Platform Enablement)

**Wave:** W4 — Global Skip Link / accessible navigation (WP1 **A-4**).
**Date:** 2026-07-02
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. What was built
- **`components/ui/skip-link.tsx`** — a reusable **`<SkipLink>`** (WP1 A-4):
  - Renders an `<a href="#main-content">` "דלג לתוכן".
  - **Visually hidden until focused** (screen-reader-only style; on focus it appears as a small pill) — **zero visual impact** on any screen.
  - **RTL-safe** (`insetInlineStart`, so it sits on the right in Dubiz's RTL UI).
  - On activation, explicitly moves focus to the target (not just the viewport).
  - Configurable `targetId` (default `main-content`) and `label`.

## 2. Where it was installed
- **`app/(shell)/layout.tsx`** — `<SkipLink />` is rendered as the **first focusable element** of the app shell, before `ShellChrome`. This is the single global insertion point for the entire authenticated app.
- **`components/navigation/shell-chrome.tsx`** — the main content container gained a **stable target**: `id="main-content"` + `tabIndex={-1}` (focusable by the skip link, not in the tab order). `+2 lines`, nothing else touched.

## 3. Areas covered
- **Every screen under the `(shell)` route group** — i.e. the whole authenticated Dubiz app (inventory, secretary, inbox, billing, settings, documents review, etc.) — because they all render through the shell layout + `ShellChrome`.
- **Not covered (out of W4 scope):** the `(corporate)` marketing site and `(platform-admin)` area. Per scope ("don't touch screens not needed"), these are deferred; the reusable `<SkipLink>` can be dropped into their layouts later with the same one-line pattern.

## 4. Constitution clauses covered
| Clause | Result |
|--------|--------|
| **A-4 skip link** | **Covered** for the entire app shell — a keyboard/SR user can jump past navigation to `#main-content`. |
| A-3 landmarks (partial) | The main content region is now identifiable via `#main-content`. It is kept a `<div>` (not `<main>`) **deliberately** to avoid a double-`<main>` if a child page already renders one. Promoting it to a single `<main>` landmark is an A-3 follow-up (see §6). |

## 5. Did business behavior stay identical?
**Yes.** The changes are purely additive accessibility: a visually-hidden anchor (first focusable) + `id`/`tabIndex` on the existing content wrapper. **No visual change** to any screen (the link is off-screen until focused), **no logic change**, **no redesign**, and `ShellChrome`'s bottom bar / padding / styles are untouched (`+2` lines only). Verified by `eslint` (0/0 on all three files) and `tsc --noEmit` (no type errors). *Honest caveat:* the keyboard Tab→"דלג לתוכן"→focus-jump was not exercised in a live browser this wave; a quick manual keyboard pass is recommended.

## 6. Backlog v2 / follow-ups
- **No new Constitution Backlog v2 gap.** A-4 was fully implementable as written; WP1 unchanged (**constitution frozen**).
- **Implementation follow-up (not a constitution gap):** the shell content is a `<div id="main-content">`, not a `<main>` landmark. A future a11y wave should audit shell pages for a **single `<main>`** (A-3) and, if none exists in children, promote `#main-content` to `<main>`. This is code remediation (tracked under the a11y workstream / audit G-9), **not** a WP1 text change, so it does not go to Backlog v2.
- **Reuse opportunity:** drop `<SkipLink>` into the `(corporate)` and `(platform-admin)` layouts when those areas are in scope — one line each, plus a `#main-content` target.

## 7. Verification (lint / typecheck)
- `eslint` — **0 errors / 0 warnings** on `skip-link.tsx`, `app/(shell)/layout.tsx`, `shell-chrome.tsx`.
- `tsc --noEmit` — **no type errors** in the W4 files.
- Diff scope confirmed: `shell-chrome.tsx` changed by exactly `+id +tabIndex`.

---

## Success Criterion — the one question
> *"Can every keyboard user skip directly to Dubiz's main content without tabbing through all the navigation?"*

**Yes** — across the entire authenticated app. The first Tab focuses "דלג לתוכן"; activating it moves focus to `#main-content`. The skip-link is now a reusable platform primitive (`<SkipLink>`), so extending it to the remaining areas is one line each. **Another WP1 building block moved from the document into the platform.**

## Files touched (W4)
`components/ui/skip-link.tsx` (new primitive) · `app/(shell)/layout.tsx` (global install) · `components/navigation/shell-chrome.tsx` (+id/tabIndex target) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W4 commit follows.
