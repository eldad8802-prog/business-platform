# English interface — performance benchmark (`DUBIZ_I18N_ENABLED` OFF vs ON)

Evidence for the owner's decision to turn the English interface on in Production. **Nothing was changed in
Production or Preview: no flag, no Vercel env, no deploy, no Neon.** All numbers come from CI on an
ephemeral PostgreSQL 17 with synthetic data.

- PR #774 (draft, DO NOT MERGE without owner). Branch `perf/i18n-flag-benchmark` from `origin/main` 3329b5cd.
- Workflow: `.github/workflows/i18n-perf-benchmark.yml` (pull_request on its own paths + workflow_dispatch).
  Scripts: `.i18n/perf-benchmark.mts`, `.i18n/payload-parity.mts`, `.i18n/perf-lib.ts`
  (+ pure tests `.i18n/perf-lib.test.ts`, 10 tests).
- **Evidence run 39878996955** (head 20069d67, with the payload fix in §3): 145/145 benchmark checks, 200/200
  before/after DOM comparisons, R2/R3/R4/R6 subset 386/386, rollback 9/9. Artifact `i18n-perf-benchmark`.
- **Baseline run 39875411697** (head 8fabd7ea, same harness, *before* the payload fix): 145/145, 386/386, 9/9.
- Same PR, full route matrix with the fix (`i18n-multicurrency-ci.yml`, run 39878996832): **4,103 passed, 0
  failed**. Hebrew parity ON = OFF: 441 identical, 0 different. E2E ON 190/190, OFF 5/5.

## 1. Summary

| | Result |
|---|---|
| Server cost of the flag (`next start`, run 39878996955) | Pages that are static today: TTFB p50 **2.6 → 5.4 ms** (+2.9 ms), p95 3.6 → 7.1 ms. Pages already dynamic today (`/home`, `/login`, …): **no change** (6.2 → 5.6 ms). Signed-in APIs: no change (0 API routes change) |
| English requests (`dz_locale=en`) | TTFB p50 ≈ **21 ms**, HTML ≈ **393 KB**: the English dictionary is serialized into each page (follow-up §8) |
| Load, concurrency 20 | App screens, one `next start` process: **1,377 → 354 req/s** (`/app`), p95 18 → 69 ms, CPU 0.9 → 3.5 ms per request, 0 errors. `/home` and `/login` (already dynamic): unchanged |
| Browser, Hebrew (390/820/1440) | TTFB **+4.4 to +5.8 ms**. FCP, LCP and "settled" are within noise (−10 to +9 ms). Load event **+5 to +13 ms** |
| Browser, English | TTFB +19 to +23 ms, DOMContentLoaded +45 to +49 ms, load +38 to +44 ms, settled +43 to +50 ms (the 393 KB HTML) |
| Hebrew default + isolation (existing R2/R3/R4/R6) | 386/386 in the same run. Full matrix on the same PR: 4,103/4,103 |
| Rollback | An OFF build serving after an ON build, same DB, browser still holding `dz_locale=en`: **he/rtl on every page, endpoint 404, signed-in text identical** to the reference OFF server (9/9). Swap took 1.4–1.9 s (process swap, no rebuild) |
| **Real performance problem found and fixed (§3)** | The root layout serialized the **whole Hebrew dictionary into every page**: about 441 KB of a 458 KB HTML document, flag OFF included. Fixed with identical output (200/200 DOM comparisons against `main`, flag OFF and ON). HTML median **458 KB → 16 KB**. This was also most of the flag-ON render cost (+11.6 ms → +2.7 ms) |
| Marketing pages | `/home` (the apex landing page), `/login`, `/register` and `/forgot-password` are **already dynamic today** (`force-dynamic`), so the flag does not change them. It moves only `/about`, `/contact`, `/privacy`, `/terms` and `/data-deletion` off the CDN. Keeping those static is possible but not behaviour-identical (§6), so it is not done |
| **Recommendation** | **GO with conditions** (§9) |

## 2. Method and environment

- **Builds.** Each run builds the PR's commit with the flag ON (`:3611`) and with it OFF (`:3612`, the same as
  Production today). It also builds a throwaway experiment (`:3613`, §6), and `origin/main` OFF and ON
  (`:3621`/`:3622`, only for the before/after proof in §3). Every build is a production build served by
  `next start`, all on one runner and one PG17. All builds finish before Chromium is installed.
- **Runner.** GitHub `ubuntu-latest`: 4 vCPU AMD EPYC 9V74 (the baseline run 39871173673 got an EPYC 7763,
  about 15% slower; the deltas point the same way), 16 GB RAM, Node 22.23.3, `CLK_TCK` 100.
- **Latency.** 33 targets:
  - 6 marketing pages, 3 auth pages and 20 signed-in app pages, including the heaviest: `/app`,
    `/collection`, `/collection/c/[id]`, `/billing`, `/billing/[id]`, `/customers`, `/customers/[id]`,
    `/leads`, `/leads/[id]`, `/settings`, `/settings/workspace`, `/secretary`, `/payables`, `/inventory`,
    `/inventory/items`, `/documents`, `/tasks`, `/profile`, `/search`, `/tools/money`;
  - 5 RSC soft-navigation payloads (`RSC: 1`, after resolving Next 16's `_rsc` 307);
  - 4 signed-in API controls with a Bearer token.

  Each target got 5 warm-up rounds, then **N = 40** measured rounds. Inside a round the variants are
  interleaved and the order flips every round (ABBA): OFF / ON / ON + `dz_locale=en` (+ the experiment
  variants for marketing pages). TTFB is the time until response headers arrive; total is the time until
  the body has been read. Quantiles are nearest-rank (`perf-lib.ts`). The latency phase also checks that
  every route returns the same status OFF and ON.
- **Sessions.** The app's session is a Bearer token in `localStorage`. A page navigation carries no
  session at all: the refresh cookie `dubiz_rt` is scoped to `/api/auth/refresh`. So the server work of an
  app page does not depend on who is signed in. Signed-in work lives in the API calls, which are measured
  separately and are signed in for real. The browser phase also runs as a real signed-in owner.
- **Load.** Five routes at a fixed concurrency of 20 for 25 s per run, in the order OFF, ON, ON, OFF, with
  a 2 s warm-up first. Measured: req/s, latency, errors. Server CPU% and RSS are read from `/proc` every
  250 ms, for the listening `next-server` pid and its descendants. The load generator's own CPU is
  reported too.
- **Browser.** Chromium on 8 routes × 390/820/1440 px × he/en × OFF/ON, signed-in owner. One warm-up round,
  then 3 measured rounds in alternating order. From the Navigation Timing API: TTFB, FCP, LCP,
  DOMContentLoaded and load. "Settled" = networkidle minus the 500 ms idle window, which includes the
  screen's own data fetches. Each table cell is the median over routes of each route's p50. The phase also
  asserts `<html lang/dir>` per cell.

## 3. Finding fixed in this PR — the dictionary was serialized into every page

`app/layout.tsx` passed `messages={getMessages(locale)}` to the client `I18nProvider`. React serializes a
Client Component's props into the RSC payload, which is inlined in every HTML document. As a result, the
entire Hebrew dictionary, about **441 KB** (114 KB gzip, 90 KB brotli), was embedded in every page. That was
about 94% of the HTML, flag OFF included, so it affects Production today. `I18nProvider` already imports the
same `he` object for its fallback, so Hebrew was downloaded twice: once in the JS bundle, which the browser
caches, and once more in every HTML document.

**Fix:** the layout now passes `messages` only for a non-default locale, and the provider uses the bundled
`he` when the prop is absent (`messages ?? he`). `getMessages("he")` *is* that object (pure identity test in
`perf-lib.test.ts`), so every string is the same.

**Proof of identical behaviour** (`payload-parity.mts`, run 39878996955): `origin/main` and this branch,
each built flag OFF and flag ON. The comparison covers 20 routes (marketing, auth, signed-in app, including
`/billing/[id]` and `/customers/[id]`) × 390/1440 px × 5 variants. The variants are: OFF with no cookie; OFF
with `dz_locale=en` (ignored); ON with no cookie; ON with `he`; ON with `en`. In Chromium, after the page
settles, the comparison checks `<html lang/dir>`, `<title>`, final path, status, visible text and the
rendered `<body>` DOM (scripts, styles and build-hashed asset URLs removed). Result: **200/200 identical**
(0 needed the clock normalisation). The full route matrix on the same PR (4,103 checks) and E2E ON/OFF are
also green.

| HTML bytes, median over 20 routes | `main` | this branch |
|---|---|---|
| flag OFF (Production today) | 457,869 | **15,719** (−96.6%) |
| flag ON, Hebrew | 457,094 | **15,559** |
| flag ON, English | 392,580 | 392,580 (unchanged; §8) |

Side effects on the same runner: `/home` 39 → 142 req/s, `/login` 45 → 398 req/s, flag OFF included. The
flag-ON render cost of a page that is static today dropped from +11.6 ms to +2.7 ms TTFB.

## 4. Server latency (run 39878996955, with the fix; ms, p50 / p95 / p99, N = 40 per route per variant)

| class | routes | TTFB OFF | TTFB ON | TTFB ON `en` | Δ p50 | total OFF | total ON | total ON `en` |
|---|---|---|---|---|---|---|---|---|
| marketing | 6 | 2.73 / 13.73 / 21.03 | 6.07 / 9.65 / 13.91 | 21.56 / 28.86 / 33.77 | +3.3 | 3.11 / 17.17 / 23.32 | 7.12 / 15.84 / 21.73 | 37.05 / 45.84 / 51.46 |
| auth | 3 | 5.48 / 7.23 / 13.66 | 4.85 / 6.49 / 12.94 | 19.76 / 25.02 / 28.63 | −0.6 | 6.12 / 13.88 / 15.51 | 5.39 / 14.71 / 17.27 | 33.43 / 39.86 / 44.06 |
| app (signed-in screens) | 20 | 2.73 / 8.06 / 11.08 | 5.41 / 9.91 / 13.73 | 20.75 / 27.23 / 30.07 | +2.7 | 3.16 / 11.18 / 15.05 | 6.18 / 15.18 / 19.16 | 34.88 / 43.08 / 56.15 |
| RSC soft navigation | 5 | 2.13 / 2.94 / 5.75 | 3.10 / 3.86 / 8.23 | 9.36 / 12.08 / 17.80 | +1.0 | 2.47 / 7.69 / 14.64 | 3.84 / 8.78 / 15.60 | 21.86 / 29.17 / 31.12 |
| signed-in API (control) | 4 | 8.44 / 11.79 / 16.86 | 8.54 / 12.27 / 17.78 | — | +0.1 | 8.59 / 11.93 / 17.02 | 8.66 / 12.42 / 17.86 | — |

The marketing class mixes `/home` (dynamic in both builds) with 5 pages that are static OFF, which is why
its p95 OFF is higher than ON. Split by what the page is today (median over routes of the route p50):

| group | routes | TTFB OFF → ON | total OFF → ON | HTML OFF / ON / ON `en` |
|---|---|---|---|---|
| static today (`○`, served from the CDN in Production) | 21 | 2.58 → 5.44 | 2.91 → 6.40 | 29.0 KB / 28.5 KB / 405.5 KB |
| already dynamic today (`ƒ`) | 8 | 6.18 → 5.60 | 6.81 → 6.14 | 15.7 KB / 15.7 KB / 392.7 KB |

Selected routes (TTFB p50/p95/p99, OFF → ON → ON `en`): `/app` 2.33/2.86/8.63 → 4.89/6.35/13.27 →
21.86/27.24/29.34. `/settings/workspace` 2.89 → 6.22 → 24.83. `/billing/[id]` 8.13 → 7.47 → 21.34. `/home`
12.12 → 8.60 → 26.35. `/login` 5.33 → 4.74 → 20.45. The per-route table for all 33 targets is in `perf.md`.
The `x-nextjs-cache: HIT` header is present OFF and absent ON exactly for the 21 static pages.

Before the fix (run 39875411697) the same table read: static-today pages 6.7 → 18.3 ms; already-dynamic
pages 20.8 → 19.0 ms; ON `en` 16–18 ms; RSC 1.65 → 7.34 ms. The flag cost was mostly the cost of
serializing the dictionary.

## 5. Load and browser (run 39878996955)

**Load**: concurrency 20, 2 × 25 s per build (OFF, ON, ON, OFF), one `next start` process on 4 vCPU.

| route | req/s OFF → ON | p95 ms OFF → ON | p99 ms OFF → ON | errors | server CPU % OFF → ON | CPU ms/req OFF → ON | RSS max MB OFF / ON |
|---|---|---|---|---|---|---|---|
| `/home` (dynamic both) | 142.1 → 146.9 | 166.6 → 172.1 | 217.4 → 211.0 | 0 / 0 | 138 → 138 | 9.8 → 9.4 | 573 / 547 |
| `/login` (dynamic both) | 398.0 → 394.4 | 61.9 → 61.6 | 78.7 → 78.3 | 0 / 0 | 119 → 119 | 3.0 → 3.0 | 651 / 639 |
| `/app` | 1376.9 → 354.0 | 17.9 → 69.4 | 22.1 → 92.5 | 0 / 0 | 128 → 122 | 0.9 → 3.5 | 651 / 530 |
| `/collection` | 1414.7 → 367.4 | 17.5 → 65.0 | 21.5 → 92.6 | 0 / 0 | 128 → 123 | 0.9 → 3.4 | 447 / 520 |
| `/settings` | 1002.3 → 261.0 | 25.3 → 89.6 | 32.0 → 115.8 | 0 / 0 | 161 → 126 | 1.6 → 4.8 | 454 / 622 |

On the static OFF runs the load generator itself used about 59% of a core, so 1,377 req/s is a lower bound
for what the static path can do. Rendering is effectively one JS thread per process (about 1.2–1.4 cores in
use including GC). RSS stays around 450–650 MB in both builds.

**Browser**: median over the 8 routes; ms; OFF → ON.

| width | locale | TTFB | FCP | LCP | DCL | load | settled |
|---|---|---|---|---|---|---|---|
| 390 | he | 2.9 → 7.3 | 48 → 44 | 156 → 148 | 21.1 → 27.7 | 97.3 → 102.9 | 226 → 235 |
| 820 | he | 2.7 → 7.8 | 36 → 40 | 144 → 136 | 19.2 → 26.8 | 94.1 → 107.0 | 244 → 234 |
| 1440 | he | 2.8 → 8.6 | 48 → 40 | 212 → 220 | 20.1 → 27.4 | 98.1 → 103.5 | 310 → 303 |
| 390 | en | 3.1 → 22.5 | 44 → 76 | 156 → 180 | 21.1 → 70.1 | 96.1 → 136.1 | 225 → 270 |
| 820 | en | 3.0 → 24.0 | 48 → 72 | 152 → 188 | 21.7 → 68.0 | 96.3 → 139.8 | 238 → 288 |
| 1440 | en | 2.9 → 25.6 | 40 → 68 | 204 → 268 | 20.0 → 64.8 | 95.7 → 134.1 | 304 → 347 |

The "en" row on OFF is the cookie being ignored, which is Hebrew. FCP/LCP are quantised to about 4 ms and
move ±10 ms between rounds. Before the fix (run 39875411697), Hebrew showed TTFB +18–19 ms, DCL +28–40 ms and load +16–27 ms.

## 6. Can the marketing pages stay static with the flag ON? (experiment, not shipped)

Experiment build `:3613`: flag ON plus `export const dynamic = "force-static"` appended to
`app/(corporate)/layout.tsx`, in a throwaway worktree only. Per the Next 16 docs (*Caching without Cache
Components → `dynamic`*), `force-static` makes `cookies()` return empty values for the route, the root
layout's call included.

- **Route table:** `/about`, `/contact`, `/privacy`, `/terms` and `/data-deletion` stay static `○`. Their
  TTFB p50 is 2.97 ms, with or without an `en` cookie, against 2.73 OFF and 6.07 ON. `/home` and
  `/home-prototype` stay dynamic (their page-level `force-dynamic` wins).
- **Output:** the server HTML (visible text, `<html>`, `<title>`, wrapper pin) is identical to flag OFF for
  no cookie / `he` / `en` on all 7 marketing pages. The current flag-ON build differs only under `en`: it
  renders `<html lang=en dir=ltr>` with a `he/rtl` wrapper.

Why it is **not implemented**:

1. **It changes what flag ON does today for an owner whose browser holds `dz_locale=en`.** The root
   `<html>` becomes he/rtl and the global accessibility button turns Hebrew.
2. **Soft navigation carries the root layout over.** The marketing header's "כניסה למערכת" is a
   `next/link` to `/login`. The root layout, which holds `<html lang/dir>` and the `I18nProvider`
   dictionary, is shared and is not re-rendered on client navigation. An English owner going from `/about`
   to `/login` would therefore get a Hebrew `/login` until a reload. That is not provably identical.
   Alternatives that would be identical, such as separate root layouts per group (which per the docs forces
   a full page load between groups) or plain `<a>` links out of the marketing site, are larger changes.
3. **The gain is small.** These are 5 low-traffic legal/contact pages. The landing page `/home` (also the
   apex `promaxgroup.co.il`) is already a function today.

If the owner wants it anyway: `force-static` on `(corporate)/layout.tsx` plus switching the marketing →
app links (`GhostCta href="/login"`, register) to full navigations. That needs its own PR and parity run.

## 7. What these numbers can and cannot say about Production (Vercel)

What CI measures: the render cost on one machine, with no network and no CDN. On Vercel the picture is
different:

- **Static pages are not served by a function today.** The 125 static + 3 SSG pages, including every app
  screen shell and their RSC payloads, come from Vercel's edge cache. With the flag ON, **128 page routes
  (every page except `/manifest.webmanifest`) become function invocations.** The app's nav links use
  `prefetch={false}`, so today every in-app click fetches a static RSC payload from the CDN. With the flag
  ON, every hard and soft navigation to these screens calls a function.
- **Expected Production delta per navigation** (an estimate, not measured): roughly
  (RTT from the user to the function region − RTT to the nearest CDN PoP) + render (≈ 3–6 ms at the CPU
  measured here) + an occasional cold start.
  - The project sets no function region (`vercel.json` has none, and no `preferredRegion`). Vercel's default
    is `iad1` (US-East) unless the project setting was changed. For users in Israel that could add on the
    order of **+100–150 ms per navigation**. With a European region (e.g. `fra1`) it is more like +40–70 ms.
  - The screens' data already comes from functions (every API route is dynamic in both builds), so the
    flag adds **one serial function round trip before the data fetch starts**. It does not double the
    data cost.
  - Cold starts on Vercel Fluid compute are rarer but can add hundreds of ms when they happen. CI cannot
    measure them.
- **Marketing:** the landing page and auth pages are already dynamic, so no change there. The 5 legal and
  contact pages lose the CDN (§6).
- **Cost:** about one function invocation per page view or soft navigation to an app screen, at
  ≈ 3.5 ms CPU (with the fix; ≈ 40 ms before it) on this runner. At the current closed-beta traffic this
  is negligible.
- **English users** download about 393 KB of HTML per hard navigation (≈ 105 KB gzip) until §8.1 is done.
  The cost is the same with or without a CDN.
- **What would measure it for real:** a Preview deployment built with the flag ON, compared against a
  normal Preview from the same commit (needs the owner to set a Preview env var; not done here), and in
  Production the first-48 h monitoring from §9.

## 8. Follow-ups (not done here)

1. **English dictionary per page.** With `dz_locale=en`, `getMessages("en")` (≈ 377 KB serialized) is still
   inlined into every HTML document. That is the remaining +18 ms TTFB and +45 ms DCL for English. Fix
   options: load `en` as a cacheable client chunk (needs care to avoid a Hebrew flash on first paint), or
   split the dictionaries per area. Not blocking for an owner-only English start.
2. `/home` is 3.5× slower to render than an app shell (9.8 ms CPU per request under load). It is
   `force-dynamic` by design, for the CTA contract.
3. Function region: confirm in Vercel → Project → Settings → Functions whether it is near the users.
   This matters with or without the flag, because every API call already goes there.

## 9. Recommendation: **GO with conditions**

Why go:

- The render cost of the flag itself is small. With the fix it adds about +3 ms of server time for
  Hebrew. There are 0 errors under load, and Hebrew FCP/LCP/settled are unchanged within noise.
- Hebrew users get the same output: R2 = 441 identical, 0 different (plus 3 intended `/settings/workspace` differences and 3 identical pre-existing `/dashboard` crashes) on the full matrix; 200/200 DOM
  comparisons against `main`. Businesses are isolated (R3).
- Rollback is immediate and proven.

Conditions:

1. **Ship the payload fix (§3) first or together with the flag.** It is in this draft PR (two files:
   `app/layout.tsx`, `components/i18n/I18nProvider.tsx`). It can be cherry-picked into its own PR. It
   benefits Production today even with the flag OFF: HTML −96%, about 90 KB less brotli per page view.
2. **Accept** that 128 page routes move from the CDN to functions. In practice that is one function round
   trip per navigation, size set by the function region (§7). Check the region; Europe beats US-East for
   Israeli users.
3. **Monitor the first 48 h:** Vercel p75 TTFB of `/app`, `/collection`, `/customers` and `/about` against
   the previous week; function invocations and cold starts; 5xx rate. Roll back (§10) if p75 navigation
   TTFB regresses by more than an agreed threshold (suggested: +250 ms), or on any 5xx increase.
4. Treat English as owner-only at first, until §8.1 lands (393 KB HTML per English hard navigation).

## 10. Rollback

**Proven in CI** (step 5, run 39878996955): while the ON build served `:3611`,
`POST /api/preferences/locale {"locale":"en"}` returned `200` + `Set-Cookie: dz_locale=en`, and `/login`,
`/app` and `/customers` rendered `en/ltr`. The ON process was then stopped and the **OFF build of the same
commit** started on the same port, against the same database. The browser kept the cookie. Results:

- `POST /api/preferences/locale` → **404**;
- `/login`, `/app`, `/customers`, `/home` and `/settings/workspace` with `dz_locale=en` → **200 he/rtl**;
- a signed-in owner holding `dz_locale=en` sees **he/rtl with visible text identical** to the reference OFF
  server on `/app`, `/customers` and `/settings/workspace` (9/9).

The swap took 1.4–1.9 s: the switch is per deployment, not per user. No data migration exists in either
direction.

**Option A — Vercel Instant Rollback (zero build, seconds; preferred).** Docs only, not executed here.

1. Vercel → project **business-platform** → Deployments. Pick the Production deployment that was live
   **just before** the flag-ON deployment: same code, built without the flag.
2. Choose **Instant Rollback**, or run `vercel rollback <deployment-url>`. The Production domains move to
   that already-built deployment. Env vars are baked into each build, so it renders with the flag OFF.
3. Then **remove `DUBIZ_I18N_ENABLED`** from the Production env. Otherwise the next deployment turns
   English back on.
4. After an instant rollback, Vercel stops auto-assigning new Production deployments to the domains until
   the rollback is undone or a deployment is promoted. Promote the next flag-OFF build when ready. Confirm
   the alias points where you expect, since auto-deploys can lag.
5. If the project `business-platform-btrl` also serves Production, repeat for it.

**Option B — remove the flag and redeploy** (≈ 2–3 min build on CI hardware; Vercel similar). Remove
`DUBIZ_I18N_ENABLED` from Production → redeploy → confirm the alias.

**Effect, either way:** every request renders Hebrew/RTL. The locale endpoint returns 404. The language
picker shows "בקרוב". Users who chose English keep a harmless `dz_locale=en` cookie that is ignored, and
return to English automatically if the flag is ever turned on again. Account emails already queued with
`locale=en` still render in English when delivered, because they are rendered from the stored row. No
data, amounts or schema change.

**Smoke after rollback:**
`curl -s -H 'Cookie: dz_locale=en' $APP/login | grep -o '<html[^>]*>'` → `lang="he" dir="rtl"`, and
`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"locale":"en"}' $APP/api/preferences/locale`
→ `404`.
