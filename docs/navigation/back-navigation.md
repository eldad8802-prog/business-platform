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
- `complete(step, consumeSteps)`: the flow committed. `step` replaces the
  step that committed, and the earlier flow steps are marked consumed (see
  below).
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
| `/inventory/supplier-purchases/new` (routes) | products → cart → confirm → send |

## What back deliberately skips, and why

Every case below is proven in a real browser. Each chain checks:
- the page each press lands on;
- that the page is the target the control computed;
- the number of committing requests (`qa-evidence/back-nav/flow-chains.md`).

**A completed flow is left as a whole.** When a flow commits, its result
screen replaces the step that committed. The flow's earlier steps are marked
*consumed* in the trail (`consumeFlowEntries`), so:
- the back control skips them;
- browser Back / Forward landing on one keeps moving the same way;
- back from the result returns to where the flow was entered, never into a
  filled step that would offer the same commit again.

| Commit (counted in the browser) | Back from the result goes to | Consumed |
|---|---|---|
| Payment request created | where `/collection/new` was opened | customer, details |
| Coupon published (also close X) | my coupons | goal, direction, builder, terms |
| Coupon redeemed | the scanner | manual / error entries |
| Item costs saved | the pricing catalog | calc, result |
| Pricing item created | the pricing catalog | new item steps 1–2 |
| Obligation met / released on the item's own screen | the list it was opened from | that item's detail / update |
| Supplier order created | where the wizard was opened | products, cart (confirm replaced) |

"Today" in the Secretary is not consumed: after completing from it, Today
moves on to the next item and stays a real step.

**Technical and transient screens are never a back target.**

| Screen | Why |
|---|---|
| `/login`, `/register`, `/onboarding`, `/api`, `/_next`, static files | Not screens to return to |
| `/payments`, `/payments/new`, `/payments/[id]` | Redirect stubs with no UI |
| `/content/render` | Starts a new, quota-consuming render on every visit. The result *replaces* it, so it leaves history for the browser too |
| `/business/bot/setup/success` | Completion screen of an activation that already happened |

**Active steps are never skipped.** Examples:
- the previous review after "next document";
- the uploader after an upload;
- a coupon or pricing step before the commit;
- "Today".

**History entries the mechanism did not create.**
- A `#fragment` jump on the same screen is stamped as a continuation of the
  entry it came from (it carries that page's Next.js state). The back control
  treats it as the same screen and still reaches the real origin. Browser
  Back first removes the fragment.
- An entry nothing recorded has no verified chain, so back shows the
  labelled fallback (with `replace`). It never steps out of the app. This
  covers:
  - a direct link after non-app history;
  - a full-document navigation (`location.assign`);
  - a lost or cleared session trail;
  - a new tab.

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
