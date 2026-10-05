# Back navigation

One mechanism for every "back" in Dubiz: the round arrow button
(`components/ui/back-button.tsx`). It goes back to the screen the user
**actually** came from, with that screen's state and scroll.

## How the destination is chosen

1. **The verified origin.** `lib/navigation/back-nav/trail-runtime.ts` stamps
   every browser history entry with an id (`history.state.__dzNav`). It does
   this by wrapping `pushState` / `replaceState`, which composes with Next's
   own patch. Each entry is recorded in sessionStorage with its URL and the
   entry it was pushed from. Back walks that chain (`trail-core.ts`) and does
   `history.go(-n)` to the first entry that qualifies. The walk:
   - skips entries for the same screen (same pathname, plus the route's
     identity params);
   - skips transient and technical screens (login, redirect stubs, the
     content render step);
   - stops at anything it did not record itself;
   - stops at an entry recorded under another account.

   Because it is real history, browser Back and Forward stay consistent, and
   nothing piles up.
2. **The declared fallback**, used only when no verified origin exists: a
   direct link, a new tab, or a chain that crosses accounts. Every sub-screen
   declares its parent in `route-registry.ts`. The button then widens into a
   pill that names the destination ("לרשימת המסמכים"), so it never pretends to
   be "back". The fallback opens with `router.replace`, which means no history
   growth and no loops. Fallback chains always walk up to a root (enforced by
   the tests).

Every target passes through `toSafeInternalPath` before navigation. That
excludes external, protocol-relative, scheme, `/login`, `/register`, `/api`,
`/onboarding` and static paths.

Rapid or repeated activations are coalesced by a lock that releases when the
history entry changes. One press moves one screen.

## Screen state and scroll

- `useEntryState(key, initial)` (`hooks/useEntryState.ts`) is a drop-in
  `useState` whose value belongs to the history entry. Use it for search,
  filter, sort, tab and page. It comes back on in-app back, browser
  Back/Forward and refresh. A fresh visit starts from `initial`.
- Window scroll is saved per entry and restored on every traversal, once the
  content is tall enough. Restoration is cancelled by user input.
- `useConsumeQueryFlag("new")` strips one-shot flags such as `?new=1`, so
  returning to a screen does not reopen its create form.

## Adding a screen

- **Root** (main-nav destination): add `{ pattern, root: true }`. It gets no
  back control.
- **Sub-screen**: add `{ pattern, parent, parentLabel }` and render
  `<BackButton />`. Do not pass a fixed href: the registry already holds the
  fallback.
- A screen routed by query (`?screen=` / `?id=`): add `identityParams`.
- A screen that must never be returned into (redirect, processing step): add
  `transient: true`.
- Unsaved changes: pass `onBeforeLeave={(proceed) => …}` and call `proceed()`
  once the user confirms. See `app/billing/[id]/page.tsx`.
- An in-screen step (a wizard step held in state, or a mobile sub-view):
  `<BackButton onClick={…} label="…" />`. This bypasses history.
- Dismissing a sheet or overlay is not back: use `<CloseButton onClick />`.
- A follow-up screen that completes an action (save → detail, upload → review,
  next item in a queue, action → result) should use `router.replace`, so back
  does not return into the finished form.

`npx tsx lib/navigation/back-nav/back-nav.test.ts` fails when a page route is
missing from the registry.

## Verification

- Logic: `npx tsx lib/navigation/back-nav/back-nav.test.ts`
- Real browser (desktop 1440, tablet 820, mobile 390): build, run
  `npx next start -p 3527`, then
  `node scripts/qa/back-nav-runtime-qa.mjs`.
