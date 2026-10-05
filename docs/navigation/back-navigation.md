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

## Steps inside a screen

A wizard or panel sequence held only in React state is invisible to back.
`useFlowStep({ steps, canShow })` (`hooks/useFlowStep.ts`) makes every step a
real history entry on the same route (`?step=…`, declared in the route's
`identityParams`). The screen stays mounted, so the data the user entered stays.
Back, from the button or the browser, walks the steps in the order actually
taken, then leaves the flow to wherever it was entered from.

- `go(step)`: the next step (push).
- `backTo(step)`: "return to X", for cancel or "back to catalog". It pops to
  the nearest earlier entry showing X, so no duplicate is stacked.
- `replaceStep(step)`: only after a completed action (see below).
- `canShow(step)`: a refresh or deep link into a step whose data is gone falls
  back to the first step.

Flows using it:

| Flow | Steps |
|---|---|
| `/collection/new` | customer → details → send |
| `/pricing` | catalog → calc → result / saved; catalog → new1 → new2 → created |
| `/revenue?view=create` | goal → direction → builder → terms → published |
| `/revenue/redeem` | scan → manual → error / done |
| `/inbox` (mobile) | triage → category list (→ conversation) |

## What back deliberately skips, and why

Each case below is proven in the browser to land on the right step and to
issue no second commit (`qa-evidence/back-nav/flow-chains.md`).

**Steps that follow a completed action, and replace the step that did it.**
Returning to that step would offer the same commit again.

| After | Replaced step | Reason |
|---|---|---|
| Payment request created | collection details | The form would create a duplicate request |
| Coupon published | coupon terms | It would publish a second coupon |
| Coupon redeemed | redeem manual entry | It would redeem again |
| Item costs saved | pricing calc form | The save is done; the result screen is shown |
| Pricing item created | pricing new item step | It would create the item twice |
| Obligation met or released | secretary detail / update (only when the action was taken there) | That screen offers the same action (a second payment) for an item that has left the open list. From "Today" the result is a normal step |

**Technical and transient screens that are never a back target.**

| Screen | Reason |
|---|---|
| `/login`, `/register`, `/onboarding`, `/api`, `/_next`, static files | Not screens to return to |
| `/payments`, `/payments/new`, `/payments/[id]` | Redirect stubs with no UI |
| `/content/render` | Starts a new, quota-consuming render on every visit |
| `/business/bot/setup/success` | The completion screen of an activation that already happened |

Every other step is a real step, and back returns to it. Examples:
- the previous review after "next document";
- the uploader after an upload;
- "Today" after completing from it.

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
  `node scripts/qa/back-nav-runtime-qa.mjs` (control, origin and fallback rules)
  and `node scripts/qa/back-nav-flows-qa.mjs` (real multi-step flow chains;
  writes `qa-evidence/back-nav/flow-chains.md`).
