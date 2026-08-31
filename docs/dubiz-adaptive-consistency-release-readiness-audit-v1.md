# Dubiz Final Adaptive Consistency + Release Readiness Audit v1

**Status:** READ-ONLY audit. No implementation, no fix PRs.
**Date:** 2026-08-31 · **Base:** `main` @ `cd8ba41`
**Method:** static scan of all 115 runtime routes (`scripts/qa/ui/adaptive-consistency-scan.mjs`)
+ a runtime sweep of 40 reachable app routes × 5 viewports = **200 cells**
(`scripts/qa/ui/adaptive-consistency-sweep.mjs`), 390 / 768 / 1024 / 1280 / 1920.

---

## 0. The short answer

After the adaptive waves the application is **structurally sound and not visually
broken**: **zero horizontal overflow in 200 runtime cells**, RTL held everywhere
a page rendered, no page-level width literal off the canonical scale in any
migrated cluster, and the secret/consumer/preview boundaries proven in
production.

What remains is **uneven adoption**, not damage. **101 of 115 routes still
declare no width intent** — they simply were never in a wave's scope. Most of
those are narrow forms that look correct anyway; a minority genuinely misbehave.

Three findings meet the project's own gating bar and are classed **BLOCKER**.
Nothing else blocks a release.

---

## 1. BLOCKER — must close before release

All three are the same defect class already fixed twice in this programme
(Billing B0, Revenue R0): a bare control collapsed to its own content box.

| # | Route | Element | Measured |
|---|---|---|---|
| **B-1** | `/documents/uniform-export` | two `<input type="date">` | **21 × 466** |
| **B-2** | `/inventory/items` | `<input type="search">` | **23 × 876** |
| **B-2b** | `/inventory/items` | icon `<button>` | **22 × 22** |
| **B-3** | `/settings/whatsapp` | `<a>` "מה נמחק ומה נשמר" | **18 × 234** |

**Why BLOCKER and not IMPORTANT:** Accessibility Constitution **A-7** states the
**gating** threshold as ≥ 24×24 CSS px (WCAG 2.2 §2.5.8), and that "DoD gating
uses the 24×24 MUST only". These are MUST-level failures on three shipped
routes, one of which (`/documents/uniform-export`) is the accountant delivery
surface.

Each is a presentation-only fix of the kind already applied twice (`min-height`
or `align-self: stretch`). Estimated cost is minutes, which is precisely why
they should not ship unfixed.

---

## 2. IMPORTANT — real, should close, does not hard-block

### I-1 · `/dashboard` crashes

`http 200`, then `TypeError: Cannot convert undefined or null to object` and the
Next.js error boundary replaces the page — at every viewport. Root cause:
`fetch('/api/reports/summary')` is sent **without an Authorization header**,
returns **401**, and the result is used unguarded.

Not a BLOCKER because the route is an **orphan**: nothing in the codebase links
to it and it is absent from `nav-destinations`. It is still reachable by URL or
bookmark, and it fails in the worst way — a blank error screen rather than a
handled state.

### I-2 · `/business/bot` and `/business/bot-settings` hide chrome unconditionally

`useHideShellChrome(true)` with no width condition — the exact defect Billing
D-1 corrected. Runtime-confirmed: `/business/bot-settings` shows **no navigation
at 1024, 1280 or 1920**, and its content is 528px wide, so desktop loses the
sidebar and gains nothing. The fix is the one already shipped twice
(`useHideShellChrome(!isDesktop)`).

### I-3 · The `/content` cluster is entirely unmigrated — 15 routes

The largest remaining surface outside the adaptive system:

- **15 routes** with page-level width literals, **all off the canonical scale**:
  900, 880, 720, 700, 680, 640, 620, 500, 480, 420, 320.
- **13 of them own raw `env(safe-area-*)`** — the safe-area contract says only
  `app/globals.css` and the shell may.
- **None declares a width intent**; none uses `PageContainer`.

Runtime: content spans the full 1920 at desktop with no container, and no
horizontal overflow. So it is *not broken* — it is simply outside the contract,
and it is where drift will re-accumulate first.

### I-4 · `/home-owner` is an orphan with no shell

No inbound link, absent from `nav-destinations`, no `ShellChrome` ancestor, no
container (content = 1920 at 1920). Either it is dead like
`components/revenue/issue/*`, or it is a surface someone still expects to work.
It needs a decision, not a fix.

---

## 3. BACKLOG — does not justify delaying release

| # | Item | Evidence |
|---|---|---|
| K-1 | **101 of 115 routes declare no width intent**; 11 use `PageContainer`, 11 use `WorkspaceLayout` | static scan §C |
| K-2 | 5 routes use non-canonical breakpoints: `/home` 640, `/documents/review/[id]` 640, `/payments/[id]` 520/840, `/billing` 980, `/pricing` 480 | static scan §B |
| K-3 | `/billing` hub keeps its `max-width: 980` arm (mobile overrides on a desktop base) | Billing closure §8 |
| K-4 | Billing z-index values bypass `LAYOUT.z` (50, 200, 220; hub 120, 130) | Billing closure §8 |
| K-5 | `window.innerWidth` in `/inbox`, `/payments/[id]`, `/brand-animation-demo` | static scan §E |
| K-6 | `/posts` is a "coming soon" placeholder with no shell | runtime |
| K-7 | `components/revenue/issue/*` — `LEGACY / DEAD — VERIFIED`, awaiting a cleanup wave | Revenue closure §11 |
| K-8 | Multi-coupon / kill-switch / ACTIVE / EXPIRED states remain unproven | Revenue closure §10 |

---

## 4. Two findings I raised and then withdrew

Recorded because the raw signal is misleading and will be seen again.

**"Double navigation on `/settings`" — false positive.** The page renders two
`<nav>` elements: `aria-label="הגדרות"` (the in-page settings list, a legitimate
navigation landmark) and `aria-label="ניווט ראשי"` (the shell sidebar). Two
*landmarks*, one *navigation surface*. Both are labelled. Not a contract breach.

**"`/dashboard` is not RTL" — wrong diagnosis.** The page is LTR because the
**Next.js error boundary** replaced it (see I-1). The RTL contract is intact; the
page is broken.

---

## 5. Canonical layout contract — adherence

| Check | Result |
|---|---|
| Breakpoints 768 / 1024 / 1280 | **110 of 115 routes** use only canonical steps (K-2 lists the 5) |
| Width intents in use | `content`, `data`, `focused`, `standard`, `workspace`, `full` — all canonical, none invented |
| `PageContainer` adoption | 11 routes |
| `WorkspaceLayout` adoption | 11 routes |
| Page-level width literals | 33 routes, **30 off-scale** — 15 of them the `/content` cluster |
| Deprecated primitives | **none** — `MasterDetailLayout` was deleted in the CRM wave and has no consumers |
| Fixed phone-width management surfaces | **none remain** — the last one (`/revenue` at 480) was removed in R1 |

The last row is the clearest measure of the programme's effect: at the start of
this work the owner's coupon management ran in a 480px column at 1920, and
Billing ran in a flat 720. Neither exists now.

## 6. Shell contract per surface class

| Class | Routes | Chrome behaviour | Verdict |
|---|---|---|---|
| **App, in shell** | most `(shell)` routes, `/billing`, `/revenue`, `/leads` | nav at every width, or hidden below 1024 by declared policy | correct |
| **Focused app task** | `/billing/[id]`, `/revenue`, `/revenue/redeem`, `/secretary` | chrome hidden below 1024, present above | correct, and deliberate |
| **Consumer** | `/revenue?view=browse`, `/revenue/coupons/[id]` | never any chrome | correct, and proven in production |
| **Preview** | `/coupon-design` | inside the shell | correct |
| **Public / pre-auth** | `(corporate)/*`, `/login`, `/register`, `/onboarding`, `/pricing` | no shell | correct — these are not app surfaces |
| **Platform admin** | `(platform-admin)/admin/*` | no shell | correct — separate surface class |
| **Dev / util** | `/dev/*`, `/upload`, `/test-upload`, `/brand-animation-demo` | no shell | acceptable |
| **Accidental** | `/business/bot`, `/business/bot-settings` | unconditional hide | **I-2** |
| **Undecided** | `/home-owner`, `/dashboard` | orphaned, no shell | **I-4**, **I-1** |

**No route hides the shell by accident except I-2.** Nothing shows two
navigation surfaces (§4).

## 7. What the new work already got right

`/leads` (#297) landed *after* the adaptive substrate and needed no remediation:
it declares `workspace`, carries the shell nav, and shows zero overflow at 390
and 1920. That is the substrate paying for itself, and it is the argument for
closing K-1 by convention rather than by another migration wave.

## 8. Recommendation

1. **Fix the three A-7 blockers** (B-1 … B-3) — presentation-only, minutes each.
2. **Decide I-1 and I-4** — `/dashboard` and `/home-owner` are orphans; delete,
   re-wire, or leave with a guard. A crashing route should not ship either way.
3. **Fix I-2** — the same one-line chrome policy already applied twice.
4. **Leave I-3 (`/content`) to its own wave.** It is 15 routes, it is not broken,
   and folding it into a release-readiness pass would repeat the mistake this
   programme has avoided throughout: doing structural work under time pressure.
5. **Do not attempt K-1 as a migration.** 101 routes without an intent is a
   convention problem. `/leads` shows new work already lands correct; enforce it
   for new and touched routes rather than sweeping 101 files.

**Release readiness:** with the three A-7 fixes and a decision on the two
orphans, the adaptive contract is releasable. Nothing found here requires
another cluster migration.
