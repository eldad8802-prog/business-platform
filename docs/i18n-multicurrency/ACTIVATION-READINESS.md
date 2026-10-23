# English interface — activation readiness (`DUBIZ_I18N_ENABLED=true`)

Evidence that turning the English interface on in Production is safe for existing (Hebrew) businesses,
and the runbook to do it. **Nothing here has been executed in Production; the flag is not set anywhere.**

- Branch `test/i18n-activation-readiness` (from `origin/main` 06f425ea). PR #758 — DO NOT MERGE without owner.
- CI: `.github/workflows/i18n-multicurrency-ci.yml` → job **English activation readiness — every route (PG17)**.
  Evidence run: **39798624592** (head fcecc7d5) — **4,022 checks passed, 0 failed**. Artifact
  `i18n-activation-readiness`: `report.json`, `matrix.json`, `route-table.json`, both build logs, both
  server logs, 876 screenshots.
- Lab: two **production builds of the same commit** (`next build` with and without the flag) served side
  by side (`next start` :3611 ON, :3612 OFF) on an ephemeral PostgreSQL 17 service container. Synthetic
  data only; no Neon, no Production, no secrets, no provider, no email sent.
- Scripts: `.i18n/activation-readiness.mts` (R1–R6), `.i18n/route-table.mts` (perf table),
  `.i18n/readiness-lib.ts` (+ pure tests `.i18n/readiness-lib.test.ts`, 7 tests, run in job 1 step 1).

## 1. Summary

| # | Question | Result (run 39798624592) |
|---|---|---|
| R1 | Every route, flag ON, he + en × 390/820/1440 | **146/146 page routes visited, 876 renders**. lang/dir correct in all 870 non-crashing renders; HTTP 200 ×870, 404 ×6 (`/settings/inbound-email`, feature-gated, same in Hebrew); **0 English-only** errors / error boundaries / page errors / overflow; horizontal overflow **0** cells in either language |
| R2 | Hebrew users unaffected | Flag ON vs flag OFF, visible text + `<title>` + lang/dir + final URL: **432/438 identical** (no cookie), **432/438 identical** (`dz_locale=he`), **288/292 identical** (English browser `Accept-Language: en-US`, no cookie). The rest: `/settings/workspace` = the one intended change (6+2), `/dashboard` = crashes identically on both builds (3+3+2, pre-existing). **0 unexplained differences, 0 needed the "volatile" normalisation.** Server HTML no-cookie vs `dz_locale=he`: **146/146 byte-identical** |
| R3 | Isolation, two businesses / two users | A switches to English in Settings → B (other browser) stays Hebrew with identical text on 8/8 screens; A's and B's rows unchanged in **all 139 business-scoped tables + Business + User rows** (md5 of every row); switching back → A's Hebrew text **byte-identical 8/8** |
| R4 | Public / customer-facing pages | **Leak found and fixed** (see §5): the Hebrew-only marketing pages rendered left-to-right under an owner's `dz_locale=en` cookie (run 39793746888: 14/14 checks failed). After the fix 28/28 pass; Hebrew renders unchanged (no attribute added) on both builds. 12 customer-facing modules reach **no** locale reader |
| R5 | Static vs dynamic | Flag ON: **125 page routes change** (121 static → dynamic, 3 SSG `/tools/*` → dynamic, + `/tools/[category]` now rendered on demand); **0 API routes change**. Only `/manifest.webmanifest` stays static |
| R6 | Emails | Account emails are stored with the requester's locale and rendered from the stored row: absent → he/rtl, `he` → he/rtl, `en` → en/ltr. No customer-facing email exists |

**Blockers for activation: none.** The one real defect (marketing pages LTR under an English cookie) is
fixed in this PR — so the PR must be merged (or the fix carried over) **before** the flag is turned on.

## 2. Route inventory (146 `app/**/page.tsx`)

All 146 were rendered; none was skipped. Dynamic segments were filled from seeded rows of business A
(customer, invoice, lead, supplier, inventory item, payment request, document, purchase order, commitment,
coupon, historical fiscal document). Audience: 127 signed-in app routes (owner of A), 12 public
(7 marketing + 5 auth screens, signed out), 7 platform-admin / dev.

Routes reached only in a limited state (reported, not hidden):

| Route(s) | State rendered | Why |
|---|---|---|
| `/admin`, `/admin/audit`, `/admin/businesses/[id]`, `/admin/businesses/[id]/features`, `/dev/content-test`, `/dev/debug-ocr`, `/dev/learning-center` | "access denied" (owner session) | platform-admin role + MFA step-up, gated by the API; internal, Hebrew-only by design (layout pins he/rtl) |
| `/recommendations/[id]` | not-found state (id 999999) | OutcomeRecommendation rows are produced by the knowledge pipeline (versioned evidence fingerprints); not hand-seeded |
| `/reset-password`, `/verify-email` | missing-token state | one-time tokens (verification is consumed on open); the issuing SQL functions come from migrations, not `db push` |
| `/settings/inbound-email` | 404 in both languages and both builds | feature-gated (not enabled in the lab) |
| `/dashboard` | crash in both languages **and on the flag-OFF build** | pre-existing: the legacy page fetches `/api/reports/summary` without the auth header → 401 → `Object.entries(undefined)`. Not linked from the app; flag-independent. Report only |
| `/content/*` flow steps (16), `/offers*`, `/promotions*`, `/revenue/issue` → `/revenue`, `/payments*` → `/collection*`, `/` → `/app` | client redirect to the parent screen | flow state / legacy aliases; the destination screens are covered |
| `/setup`, `/onboarding` | rendered with a not-yet-set-up business (S) | a set-up business is sent on to Home |

Lab-only noise (identical in he/en and on both builds): `/app`, `/documents*` log HTTP 500 from
`/api/documents/inbox` because the lab has no Upstash rate-limiter credentials; `/revenue/redeem` has no
camera. Console errors: 60 in Hebrew, 60 in English, **same count on every route/width** (0 differ).

## 3. English quality — Hebrew still visible in English (excluding user data)

Reported, not failed. 13 routes; 4 are the platform-admin denied page (internal, Hebrew by design).

| Route | Hebrew left | Source / nature |
|---|---|---|
| `/settings/import-export/{import,export,templates}` | domain names + descriptions (לקוחות / ספקים / לידים / מלאי …) | `lib/data-transfer/domains.ts` — not yet in the dictionaries |
| `/settings/import-export/historical`, `…/records`, `…/records/[id]` | explanation text, "יובא ממערכת אחרת", document type names | `lib/data-transfer/historical/historical-owner-language.ts`, `HistoricalRecordsScreen.tsx` |
| `/inventory/items` | "מלאי קריטי: …" | persisted alert row (`lib/services/inventory/inventory.service.ts:200`) — persisted rows are intentionally Hebrew (B-4) |
| `/coupon-design` | sample coupons (קפה נחמה, פיצה רומא …) | design-preview demo data (`components/coupon/coupon-model.ts`) |
| `/dev/content-test` | "כניסה ישירה ל־CREATE" | internal dev page |
| `/admin*` (4) | "גישה נדחתה …" | internal, Hebrew-only |

Nice-to-have, not blocking: translate the import/export + historical strings (≈30 strings, 2 files).

## 4. Hebrew users unaffected — method and normalisation

For every route × width, the flag-OFF build (= Production today) and the flag-ON build are opened **at the
same moment** with the same signed-in owner and the same data; compared: `<html lang/dir>`, `document.title`,
final pathname, and `document.body.innerText`.

- **raw** = whitespace runs collapsed (re-flow is not a text change). 1,152 of the 1,160 non-crash
  comparisons were identical at this level; the other 8 are the intended `/settings/workspace` change.
- **volatile** (documented, never needed in this run) = raw + clock times → `HH:MM`, numeric dates → `DATE`,
  Hebrew relative ages ("לפני 3 דקות") → `לפני N`. Amounts, counts, names, labels and ids are never normalised
  (pinned by `.i18n/readiness-lib.test.ts`).
- A difference is retried up to 3× (fresh snapshot of both builds) before it counts; retries are listed in
  `report.json` (`parity.retried`). This run: 1 retry (desktop `/business/identity`, no cookie — a data
  fetch still in flight; identical on the 2nd snapshot).
- **Intended difference:** `/settings/workspace` — flag OFF shows "בקרוב" under the disabled language buttons;
  flag ON the buttons work and the line is gone. This is the only screen a Hebrew user sees change.
- **English browser:** a browser with `Accept-Language: en-US` / `navigator.language = en-US` and no cookie is
  Hebrew and identical to OFF on 288/290 non-crash renders (+2 `/settings/workspace` intended). The locale
  comes from the `dz_locale` cookie only.
- Server HTML (`fetch`, same build) with no cookie vs `dz_locale=he`: byte-identical 146/146.

## 5. Public & customer-facing pages

| Surface | Under an owner's `dz_locale=en` (flag ON) | Verdict |
|---|---|---|
| Marketing site `(corporate)`: `/home`, `/about`, `/contact`, `/privacy`, `/terms`, `/data-deletion`, `/home-prototype` | **Before:** `<html lang=en dir=ltr>` → Hebrew content laid out LTR (run 39793746888, 14/14 fail). **After this PR:** content wrapper `lang=he dir=rtl`, computed direction rtl, no overflow (14/14 pass) | **Fixed** (`app/(corporate)/layout.tsx`) |
| Web-form lead "thank you" page (`/api/intake/acquisition/web/[publicId]`) | own `<html lang="he" dir="rtl">` document, reaches no locale reader | unchanged |
| Invoice / quote PDF (`/api/billing/documents/[id]/pdf`, `billing-pdf-html-template.ts`) | own `<html lang="he" dir="rtl">` template, reaches no locale reader | unchanged |
| WhatsApp / share texts to customers (payment request `collection-message.ts`, invoice/quote/coupon share in `app/billing/[id]`, `app/revenue/coupons/[id]`, `coupon-display.tsx`) | hard-coded Hebrew, no translator | unchanged |
| Payment provider pages (CardCom / SUMIT / PayPal request builders, `payment-request.service.ts`) | reach no locale reader; hosted by the provider | unchanged |
| Uniform tax file | reaches no locale reader | unchanged |
| Payment return URL (`/?payment=…`) | apex → marketing home (pinned), other hosts → `/app` | unchanged |

The fix, and why it is flag-off-identical: the layout adds `lang="he" dir="rtl"` to its wrapper **only when
`getRequestLocale()` is not `he`**. With the flag OFF, `getRequestLocale()` returns `he` without reading
cookies, so no attribute is rendered: R4 asserts the wrapper has no `lang`/`dir` on the flag-OFF build and on
the flag-ON build without a cookie (7 routes × 2), R2 shows the marketing pages identical to OFF, and the
flag-OFF route table is identical before and after the fix (marketing pages stay static `○`).

Residual (accepted, low): on marketing pages with an English cookie the root `<html lang>` is still `en`
(the wrapper re-declares `he`), and the floating accessibility button outside the wrapper is in English.
A customer's own browser never carries `dz_locale` (the cookie is set only by the owner's language switch,
on the owner's device), so customers see Hebrew regardless.

## 6. Performance / caching (route table, flag OFF vs ON)

| | static `○` | SSG `●` | dynamic `ƒ` |
|---|---|---|---|
| flag OFF (today) | 122 | 3 | 26 |
| flag ON | 1 (`/manifest.webmanifest`) | 0 | 148 |

125 page routes change; 0 API routes change (full list: `route-table.json`). Why: the root layout calls
`cookies()` when the flag is on, which opts every page into request-time rendering.

Expected impact:
- The marketing site (`/home`, `/about`, …, the apex `promaxgroup.co.il` landing) is no longer served as a
  prerendered static file from the CDN; every hit renders on a serverless function (higher TTFB, more
  function invocations; content and SEO markup unchanged).
- App screens are client-rendered shells: each navigation now does a small server render instead of a
  static file — modest extra latency/invocations; data fetching is unchanged (APIs were already dynamic).
- `/tools/money|customers|operations` lose build-time generation (now on demand).
- Mitigation if this matters (not done, needs a decision): move the marketing pages to their own root
  layout that never reads cookies, keeping them static.

## 7. Emails / notifications

- The 3 email kinds (WELCOME, EMAIL_VERIFY, PASSWORD_RESET) all go to the account owner. Register / forgot /
  resend / verify routes read the locale via `getServerI18n()` (cookie, flag-gated) and store it in
  `TransactionalEmail.locale`; delivery renders from the stored row (`delivery.ts:148`). R6: absent → he/rtl,
  `he` → he/rtl, `en` → en/ltr. With the flag OFF the resolver answers `he` without reading a cookie.
- The WELCOME of a verified account uses the language of the browser that opened the verification link.
- Customer-facing messages (WhatsApp collection / share texts) and persisted notifications/insights stay
  Hebrew (not interface copy). Nothing customer-facing switches language.

## 8. Known gaps (none blocking)

1. **Language is per device/browser** (`dz_locale` cookie, 1 year). It does not follow the user to another
   device, survives sign-out, and on a shared browser the next user inherits it. Fixed by the stored
   per-user preference (migration `20261025090000` + its app PR) — not applied / not built here.
2. Hebrew left in English on 9 non-internal routes (§3).
3. Platform-admin and `/dev/*` stay Hebrew (internal).
4. Persisted rows (notifications, insights, inventory alerts) stay in the language they were written in (Hebrew).
5. Owner-side coupon *previews* are translated while the real outbound share text stays Hebrew.
6. Pre-existing, flag-independent: legacy `/dashboard` crashes (§2).
7. Real phones/tablets not tested (Chromium emulation at 390/820/1440).

## 9. Activation runbook (for the owner to execute or approve — NOT executed)

**Preconditions**
1. PR #758 merged to `main` (carries the marketing-page fix) and live in Production — or the fix merged separately.
2. CI of that `main` commit green, including *English activation readiness*.
3. Owner decision on §6 (marketing pages become dynamic) and §8.1 (per-device language).

**Steps**
1. Vercel → the project(s) serving Production (**business-platform**; confirm whether **business-platform-btrl** also serves Production) → Settings → Environment Variables → add
   `DUBIZ_I18N_ENABLED` = `true`, environment **Production** only.
2. Redeploy the current Production deployment (Deployments → latest Production → Redeploy). The flag takes
   effect **per build**: setting the variable alone changes nothing until a new build is live.
3. Confirm the alias points at the new deployment (auto-deploys can lag / land out of order).

**Post-activation smoke** (replace `$APP` with the Production app URL, `$APEX` with `https://promaxgroup.co.il`)
```bash
curl -s $APP/login | grep -o '<html[^>]*>'                                   # lang="he" dir="rtl"
curl -s -H 'Accept-Language: en-US,en' $APP/login | grep -o '<html[^>]*>'   # still lang="he" dir="rtl"
curl -s -H 'Cookie: dz_locale=en' $APP/login | grep -o '<html[^>]*>'        # lang="en" dir="ltr"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{"locale":"en"}' $APP/api/preferences/locale                        # 200 (was 404) + Set-Cookie dz_locale=en
curl -s -H 'Cookie: dz_locale=en' $APEX/ | grep -o 'lang="he" dir="rtl"' | head -1   # marketing content pinned
```
Browser: sign in as the owner → Settings → "שפה, אזור ומטבע" → English → screens in English, LTR; another
browser/user stays Hebrew; switch back → Hebrew. Check one invoice PDF and one payment-request share text
are still Hebrew.

**Rollback**
1. Remove `DUBIZ_I18N_ENABLED` (or set it to anything other than `true`) for Production and redeploy.
2. Effect: every request renders Hebrew/RTL again; `POST /api/preferences/locale` → 404; the language
   buttons show "בקרוב". Users who chose English keep a harmless `dz_locale=en` cookie that is ignored —
   they see Hebrew; if the flag is re-enabled later they return to English automatically.
3. Account emails already queued with `locale=en` (reset 1 h / verify TTL) still render in English when
   delivered (rendered from the stored row). No data, amounts or schema are touched in either direction.

**Monitoring (first 48 h)**
- Vercel: 5xx rate and p75 TTFB of `/home`, `/login`, `/app` vs the previous week (static → dynamic);
  function invocations.
- Logs: `POST /api/preferences/locale` volume and status (only 200/400 expected).
- Support: any report of Hebrew pages laid out left-to-right, or of an English email/share text reaching a customer.

## 10. What the owner must approve
1. Merge PR #758 (test harness + the marketing-page fix).
2. Turning the flag on in Production (§9), accepting §6 (marketing pages dynamic) and §8.1 (per-device language).
3. Separately, later: the stored user preference (migration `20261025090000` + app PR).
