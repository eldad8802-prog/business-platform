# Revenue Adaptive Design Report v1

**Status:** DESIGN / AUDIT ONLY — awaiting owner approval of the Management /
Consumer / Preview separation. **No Revenue code was changed.**
**Date:** 2026-08-31 · **Base:** `main` @ `9507a69`
**Evidence:** code read + a runtime matrix of 5 surfaces × 7 viewports
(`scripts/qa/ui/revenue-audit.mjs`) + an anonymous-reachability probe. The audit
issues, redeems, enables and disables nothing.

> **Evidence tiers.** *RUNTIME REACHABLE* = rendered and measured this run.
> *IMPLEMENTED BUT NOT CURRENTLY REACHABLE* = the code path exists but no data in
> the environment reaches it. *INFERRED ONLY* = read in the source, never rendered.

---

## 1. Route inventory

| Route | Reality |
|---|---|
| `/revenue` | The whole feature. Three views in one URL: `?view=mine\|browse\|create` |
| `/revenue/redeem` | Redemption (scanner + manual code) |
| `/revenue/coupons/[id]` | A single issued coupon, by **public UUID** |
| `/coupon-design` | Interactive design-package demo |
| `/revenue/issue`, `/offers`, `/offers/create`, `/promotions`, `/promotions/coupons` | **All five `redirect("/revenue")`** — they are not surfaces |

So Revenue is **four real surfaces**, not the nine the route tree suggests. Do not
plan waves against the redirect stubs.

**`/revenue` has no `layout.tsx` at all.** Unlike `/offers` and `/coupon-design`,
which wrap themselves in `ShellChrome`, the real Revenue management area is
*outside the app shell by construction* — there is no navigation to hide, at any
width. (`/revenue/page.tsx` still calls `useHideShellChrome(true)`; that call is
currently inert, and would only matter if a layout were added.)

## 2. Component inventory

| Component | Lines | Home |
|---|---|---|
| `CouponCreationFlow` | 698 | `components/coupon/screens/creation-screens.tsx` |
| `RedeemScreen` | 588 | `components/revenue/redeem/redeem-screen.tsx` |
| `ConsumerJourney`, `PublicCouponContent`, `MarketplaceGrid`, `CouponStatesScreen` | 540 | `components/coupon/screens/consumer-screens.tsx` |
| `coupon-model.ts` | 477 | domain types + validation |
| `MyCouponsScreen` | 286 | `components/coupon/screens/my-coupons-screen.tsx` |
| `CouponWorld` | 243 | `components/coupon/screens/marketing-center.tsx` |
| `PhoneFrame` + primitives | 280 | `components/ui/coupon/coupon-primitives.tsx` |
| `components/revenue/issue/*` | ~800 | **orphaned** — `/revenue/issue` redirects away |

**`components/revenue/issue/*` (9 files, ~800 lines) has no reachable route.** Its
page redirects to `/revenue`. Dead surface, or a surface awaiting re-wiring — worth
an owner call before any wave plans around it.

## 3. Management / Consumer / Preview classification

| Surface | Class | Basis |
|---|---|---|
| `/revenue?view=mine` — `MyCouponsScreen` | **MANAGEMENT** | owner's own coupons; carries the **kill switch** (`disableCoupon` / `enableCoupon`, lines 148/153) |
| `/revenue?view=create` — `CouponCreationFlow` | **MANAGEMENT** | 6-step authoring wizard (`intro → goal → direction → builder → terms → published`) |
| `/revenue?view=browse` — `ConsumerJourney` | **CONSUMER**, embedded in management | the public marketplace ("הטבות קרוב אליך"), reached from the owner's own app |
| `/revenue/redeem` — `RedeemScreen` | **MANAGEMENT** | the owner scans a customer's coupon at the counter |
| `/revenue/coupons/[id]` | **CONSUMER** | consumes `PublicCouponDetailsDTO`; its API has **no auth** |
| `/coupon-design` — `CouponWorld` | **PREVIEW** | self-described "חבילת עיצוב שלמה … מסע אחד רציף (אינטראקטיבי)" |
| `PublicCouponContent`, `CouponCreationFlow` | **SHARED** | mounted by both the real journey and the preview |
| `components/revenue/issue/*` | **UNCLEAR** | no reachable route; cannot determine intended audience from the code |

The classification that matters most: **`?view=browse` puts a consumer surface
inside the management URL space**, and **`/revenue/coupons/[id]` puts a consumer
surface under the management route prefix**. Neither is wrong today, but both make
"Revenue = the owner's area" false as a blanket statement.

## 4. Current width architecture

Runtime-measured, 7 viewports:

| Surface | 320 | 390 | 768 | 1024 | 1280 | 1440 | 1920 |
|---|---|---|---|---|---|---|---|
| `/revenue` (all 3 views) — frame | 320 | 390 | **480** | **480** | **480** | **480** | **480** |
| `/revenue` — `<main>` | 320 | 390 | 768 | 1024 | 1280 | 1440 | 1920 |
| `/revenue/redeem` | 320 | 390 | 768 | 1024 | 1280 | 1440 | 1920 (inner cap 520) |
| `/coupon-design` — `<main>` | 320 | 390 | 692 | 776 | 1032 | 1192 | 1672 |

At 1920 the Revenue management surface is a **480px column with ~1440px of dead
canvas and no navigation**. Zero horizontal overflow anywhere — the surface is not
broken, it is unused.

`/coupon-design` is the only Revenue route whose main tracks the shell content
width, because it is the only one inside `ShellChrome`.

## 5. Phone-frame inventory

`PhoneFrame` (`coupon-primitives.tsx:29`) is **one primitive with two modes**,
selected by `ScreenModeContext`:

| Mode | Cap | Radius / shadow | min-height | Meaning |
|---|---|---|---|---|
| `screen` | **480** | 0 / none | `100vh` | a real application screen |
| `device` (default) | **390** | 22 / drop shadow | 720 | a **mock** of a phone |

`ScreenModeProvider mode="screen"` is set in exactly one place:
`app/revenue/page.tsx:158`. Everything under `/revenue` therefore renders as a
480px "screen"; everything under `/coupon-design` renders as 390px mocks.

| Frame | User | Interactive management UI? | Preview only? | Verdict |
|---|---|---|---|---|
| `/revenue?view=mine` @480 | business owner | **yes** — create, kill-switch, retry | no | **adaptive architecture problem** |
| `/revenue?view=create` @480 | business owner | **yes** — the whole wizard | no | **adaptive architecture problem** |
| `/revenue?view=browse` @480 | business owner, viewing consumer content | browsing only | closer to a real consumer surface than a mock | **defensible** |
| `/revenue/redeem` | business owner | yes | no | no frame — inner cap 520 |
| `/coupon-design` ×4 @390 mocks | designer / owner reviewing | no | **yes** | **phone frame is correct here** |

Against §8's canonical principle: **the owner manages the business inside a phone
frame on two of the four surfaces**, including the kill switch. That is the finding
this wave exists for.

## 6. Runtime viewport evidence

- **Zero horizontal overflow** on all 35 measured cells.
- **RTL preserved** everywhere.
- **Shell navigation**: present only on `/coupon-design` (248px sidebar ≥1024).
  Absent at every width on every real Revenue surface.
- **A-7 gating failures**: a 21px target on `?view=browse` and on `/coupon-design`,
  at all seven viewports.
- **Anonymous reachability** (no token at all): `/revenue` → 200, `/revenue/redeem`
  → 200, `/coupon-design` → 200 and fully rendered (2,127 chars of text). None
  redirects to login. The management shells render for anonymous visitors; their
  API calls would fail, but the routes do not gate.

## 7. State inventory and reachability

The dev tenant holds **0 offers and 0 coupons** (`/api/offers` → `{"offers":[]}`,
`/api/revenue/coupons/mine` → `{"coupons":[]}`, `/api/revenue/coupons/active` →
`{"coupons":[]}`).

| State | Where | Tier |
|---|---|---|
| `mine` loading / empty | `MyCouponsScreen` | **RUNTIME REACHABLE** |
| `mine` error + retry | `MyCouponsScreen:239` | **IMPLEMENTED, NOT CURRENTLY REACHABLE** |
| marketplace empty | `ConsumerJourney` | **RUNTIME REACHABLE** |
| creation `intro` | `CouponCreationFlow:177` | **RUNTIME REACHABLE** |
| creation `goal / direction / builder / terms / published` | `creation-screens` | **IMPLEMENTED, NOT CURRENTLY REACHABLE** without authoring a draft |
| coupon `ACTIVE / REDEEMED / EXPIRED / CANCELLED` | `CouponStatus` enum | **IMPLEMENTED, NOT CURRENTLY REACHABLE** — no coupon exists |
| kill-switch disabled ⇄ enabled | `MyCouponsScreen:148/153` | **IMPLEMENTED, NOT CURRENTLY REACHABLE** |
| redeem idle / scanning / success / error / loading | `components/revenue/redeem/*` | idle **RUNTIME REACHABLE**; the rest **IMPLEMENTED, NOT CURRENTLY REACHABLE** |
| public coupon page, valid / invalid / expired token | `/revenue/coupons/[id]` | **IMPLEMENTED, NOT CURRENTLY REACHABLE** — no coupon id exists |
| `CouponStatesScreen` (a states gallery) | `consumer-screens:529` | **INFERRED ONLY** — no route mounts it |

Reaching the unreachable ones means creating an offer and **issuing a coupon**,
which §14 lists as a protected invariant. Not done.

## 8. Business invariants — where they live

| Invariant | Home | Client involvement |
|---|---|---|
| Offer semantics (`title`, `customerBenefitText`, `validUntil`, `isActive`) | `Offer` model + `offer.service.ts` | display + form input only |
| Coupon issuance | `coupon.service.ts::createCouponFromOffer` | triggers, never derives |
| Coupon state | `CouponStatus` enum — `ACTIVE / REDEEMED / EXPIRED / CANCELLED` | display only |
| Token / QR secrecy | `Coupon.token`, `Coupon.qrValue`, both `@unique`; `/code` route is **401 / 403 / 200** issuer-only | never rendered outside the issuer surface |
| Public identity | `Coupon.publicId` (UUID) — the only id in public URLs | display only |
| Expiration | `Coupon.expiresAt` | display only |
| Redemption | `redeem.service.ts::redeemCoupon`; `RedemptionEvent?` is **1:0..1**, so single use is a schema guarantee | triggers only |
| Kill switch | `/api/revenue/coupons/[id]/disable\|enable`; authorization compares `issuingBusinessId` server-side, **unconditional** | button only |
| Ownership | `issuingBusinessId` on both Offer and Coupon | not client-decidable |

**The client computes no coupon state and holds no authority.** As with Billing,
that is what makes a presentation wave tractable here.

## 9. Offer → Coupon → token → redemption → kill-switch authority map

```
Offer (issuingBusinessId, validUntil, isActive)
  └─ createCouponFromOffer ──► Coupon
                                 ├─ publicId  (UUID) ──► PUBLIC   → /revenue/coupons/[id], /api/revenue/coupons/[id]  (no auth)
                                 ├─ token/qrValue    ──► SECRET   → /api/revenue/coupons/[id]/code  (401/403/200, issuer only)
                                 ├─ status           ──► ACTIVE | REDEEMED | EXPIRED | CANCELLED
                                 ├─ redeemCoupon     ──► RedemptionEvent (1:0..1 = single use)
                                 └─ disable/enable   ──► kill switch, server-side issuingBusinessId check
```

**The one line an adaptive redesign must not blur:** `publicId` is public,
`token`/`qrValue` are not. Any composition that puts "the coupon's identity" and
"the coupon's code" in the same visual region invites exactly that mistake. The
current UI keeps them apart — the code is fetched by a separate issuer-only call
(`fetchCouponCode`) — and the redesign must keep them apart.

Second boundary worth stating: **the kill switch lives on the management list, not
on the coupon**. Splitting `MyCouponsScreen` into a list plus a detail pane must
not leave the kill switch on a surface that reads as informational.

## 10. Management UX problems

1. **A 480px column at 1920 with no navigation.** The owner's coupon management —
   including the kill switch — is a phone screen on a desktop monitor, and there is
   no way out of the feature except the in-page back control.
2. **Three different jobs share one URL.** `mine`, `browse` and `create` differ in
   audience and in shape, but all render into the same 480 frame.
3. **`components/revenue/issue/*` is orphaned** — ~800 lines behind a redirect.
4. **`/revenue` is outside the shell by construction**, so the fix is not the
   Billing fix (a width-aware hook) but adding a layout, which is a bigger call.

## 11. Consumer UX problems

1. `?view=browse` and `/revenue/coupons/[id]` are consumer surfaces reachable
   through management URLs; a shared link exposes management route structure.
2. Neither was verifiable at desktop widths this run — no coupon exists — so the
   consumer responsive contract is **unproven**, not proven-good.
3. All Revenue routes render for anonymous visitors rather than gating.

## 12. Preview fidelity and drift

**Better than expected — there is no duplication.** `CouponWorld`
(`marketing-center.tsx:22-23`) imports the *real* `CouponCreationFlow` and the
*real* `PublicCouponContent`. The preview mounts the production components inside a
mock frame; it does not re-implement their markup.

Authority: the **consumer/creation components are the authority**; the preview is a
host. Two caveats:

- `CouponWorld` also renders a bespoke "הכלים שלך" tools grid that exists nowhere
  else — preview-only content presented alongside real components.
- `MyCouponsScreen` (management) is **not** in the preview, so the preview covers
  the consumer and creation halves only.

**Drift risk is low and structural, not textual**: the same components render at
390 inside the preview and 480 inside `/revenue`. If the wave changes the real
components' layout at desktop, the preview inherits it for free — which is the
right outcome and worth preserving deliberately.

## 13. Proposed canonical intents

Derived from what each surface *is*, not from a template:

| Surface | Intent | Reasoning |
|---|---|---|
| `/revenue?view=mine` | **`workspace`** at ≥1280, `content` below | a list of coupons plus per-coupon actions — the CRM shape |
| `/revenue?view=create` | **`focused`** | an authoring wizard; a form does not want 1280 |
| `/revenue?view=browse` | **`content`** | a consumer feed the owner is reading |
| `/revenue/redeem` | **`focused`** | one input, one scanner — already effectively this at 520 |
| `/revenue/coupons/[id]` | **`focused`**, consumer-first | one artifact on a customer's phone |
| `/coupon-design` | unchanged | already inside the shell and correctly sized |

**No Revenue-specific primitive is proposed.** `WorkspaceLayout`, `PageContainer`
and `AdaptiveOverlay` cover all six. The 480 `screen` mode of `PhoneFrame` would be
retired for management surfaces and **kept for preview**.

## 14. Proposed Mobile management (320–767)

**Unchanged.** The 6-step wizard, the stacked list and the scanner are all correct
mobile compositions. The only mobile change proposed is the 21px target (§6).

## 15. Proposed Tablet management (768–1279)

Release the 480 cap so the list and wizard take a `content` measure instead of
rendering the phone layout with 288px of margin each side. **No side region** —
the second region waits for 1280, as it does everywhere else in the platform.

## 16. Proposed Desktop management (1280+)

For `?view=mine` only, and **adding no capability**:

```
┌──────────────── 1280+ ────────────────┐
│ sidebar │   coupon list   │  detail   │   RTL: sidebar inline-start
│  248*   │      380        │  content  │
└───────────────────────────────────────┘
```

Left pane content is exactly what the list row already shows plus the actions it
already carries — status, offer title, dates, and the existing kill switch. **No
metrics, no analytics, no new controls**: none exist today, and adaptive work is
not feature expansion.

`* sidebar` requires giving `/revenue` a layout (§10.4) — an owner decision, not a
free consequence.

`?view=create` stays a focused column at every width. `?view=browse` becomes a
`content` feed. `/revenue/redeem` stays focused.

## 17. Consumer responsive contract

`/revenue/coupons/[id]` and the marketplace stay **mobile-first**, and are not
turned into desktop management UI. What they owe at desktop is only: no horizontal
overflow, a sane centred measure, and a legible QR. **Currently unverified** — no
coupon exists to open, so this must be proven before any consumer-side change is
called safe.

## 18. Component-boundary proposal

| Move | Why | Risk |
|---|---|---|
| `MyCouponsScreen` → list + detail | to fill the workspace regions | **MEDIUM** — carries the kill switch |
| `PhoneFrame` `screen` mode → retire for management, keep for preview | it is the 480 cap | LOW |
| `ScreenModeProvider` scope | today one provider wraps all three views | LOW |
| `components/revenue/issue/*` | resolve orphan status first | **UNCLEAR** |
| `CouponCreationFlow`, `PublicCouponContent` | **do not move** — shared with the preview | HIGH if moved |

No duplication to unify (§12). Nothing to merge.

## 19. Risk map

**LOW — presentation / composition:** container widths and intents; releasing the
480 cap; tablet measure; the 21px target; preview left as-is.

**MEDIUM — component movement / shared state:** splitting `MyCouponsScreen`;
scoping `ScreenModeProvider`; adding a `/revenue` layout (changes chrome for three
routes at once).

**HIGH — do not touch:** coupon/offer semantics, `CouponStatus`, redemption,
`token`/`qrValue` exposure, `publicId` URL semantics, expiration, issuance,
ownership, kill-switch behaviour, `RedemptionEvent` single-use, `/code`
authorization, public API contracts.

## 20. Proposed migration waves

Derived from this audit, not from a template:

| Wave | Content | Gate |
|---|---|---|
| **R0** | Regression substrate: a Revenue snapshot harness (coupon states, token exposure, action availability, request parity) + the 21px target | harness green on reachable states |
| **R1** | Resolve two structural questions **before** any layout work: is `components/revenue/issue/*` alive, and does `/revenue` get a layout? | owner decision |
| **R2** | Container intents: retire the 480 management cap, `?view=create` → focused, `?view=browse` → content, tablet measure | matrix green, single region everywhere |
| **R3** | `?view=mine` workspace at 1280 via `WorkspaceLayout` | matrix + kill switch still on an actionable surface |
| **R4** | Consumer responsive verification at 320–1920 — needs a real coupon | blocked on state availability |
| **R5** | Overlays and states: `full-screen-qr-modal` → `AdaptiveOverlay`; state coverage | overlay tests |

R4 is listed **as blocked**, not as scheduled.

## 21. Regression strategy

The Billing lesson transfers directly. Before any change, snapshot per surface per
viewport: coupon **status strings**, action availability with disabled state,
**whether `token`/`qrValue` ever appear in the DOM** (they must not, outside the
issuer surface), the public/secret id split, and the **`/api/` request tally** —
which is what caught the hydration remount in Billing.

Add one Revenue-specific assertion Billing did not need: **a coupon's secret code
must never be rendered on a surface reachable without the issuer session.**

Composition should be **CSS-driven** wherever behaviour need not change, for the
reason recorded in `docs/billing-adaptive-production-closure-v1.md` §9.

## 22. Open owner decisions

- **V-1 — Is `components/revenue/issue/*` alive?** ~800 lines behind a redirect.
  Delete, re-wire, or leave? Blocks R1.
- **V-2 — Does `/revenue` get a `layout.tsx` with `ShellChrome`?** Today the owner
  has no navigation in the entire feature. *Recommend yes, at ≥1024 only*, matching
  the Billing D-1 outcome.
- **V-3 — Should `?view=browse` and `/revenue/coupons/[id]` stay under `/revenue`?**
  Consumer surfaces in a management URL space. Presentation wave can leave them;
  moving them is a routing decision.
- **V-4 — Consumer verification.** R4 needs a real coupon. Same shape as Billing's
  D-3: authorize dev-only issuance, or accept the consumer contract as unverified?
  *No recommendation offered — this is an issuance decision.*
- **V-5 — Three views, one URL.** Keep `?view=`, or split into routes? Affects
  whether R3's workspace is a route or a view.

## 23. Final recommendation

**Proceed to R0/R1 only, and treat V-1 and V-2 as blocking.**

The phone frame is not the problem — *its mode* is. One primitive serves both a
real 480px application screen and a 390px design mock, and the management surfaces
picked the wrong one. Retiring `screen` mode for management while keeping the mock
for preview is a small, well-bounded change, and the preview keeps working for free
because it already mounts the production components.

Two things make this wave cheaper than Billing: the client holds **no coupon
authority** (§8), and there is **no preview/consumer duplication to unify** (§12).
Two things make it riskier: most states are **unreachable without issuing a
coupon** (§7), and the surface carries a **secret** (`token`/`qrValue`) that a
careless recomposition could expose (§9).

Do not start R2 before V-1 and V-2 are answered: both change what "Revenue
management" structurally *is*, and laying out a surface whose chrome and component
set are still undecided would be work done twice.
