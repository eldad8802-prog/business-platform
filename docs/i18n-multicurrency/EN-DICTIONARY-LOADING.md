# How the English dictionary reaches the browser

Status: PR "perf(i18n): English dictionary as a cached client chunk — off the HTML" (DO NOT MERGE without owner).
Scope: delivery of the client dictionary only. No dictionary text, design, RTL/LTR, flow, payment or flag change.

## 1. Audit: where `en` travelled before this change (origin/main, after #777)

| path | what carries the dictionary | when |
|---|---|---|
| `app/layout.tsx` (Server Component) → `<I18nProvider messages={getMessages(locale)}>` (Client Component) | the whole `en` object as a **client-component prop**, i.e. serialized into the RSC payload. On a hard navigation the RSC payload is inlined into the HTML (`self.__next_f.push(...)` script chunks), so it is part of every HTML document | every **full page load** of an English user (Production: ≈393 KB raw / ≈115 KB br per document, vs ≈3.5 KB br for Hebrew) |
| same prop, RSC-only response | the root layout is re-rendered and the prop re-sent | any request for the full tree: `router.refresh()` (the app has 0 calls today), a full-tree `RSC: 1` fetch. Soft navigations (`<Link>` / `router.push`) do **not** re-send it: the root layout is a shared segment and is not re-rendered |
| Server Components that call `getServerI18n()` (35 files: shell/section layouts, `/collection*`, `/profile`, `/billing`, `/business/identity`, …) and ~50 Route Handlers | **nothing reaches the browser** — they translate on the server and emit the rendered text only | — |
| Hebrew (`he`) | bundled into the `I18nProvider` client module since #777; no prop | always (unchanged by this PR) |

Client consumers: ~279 files call `useI18n()` (every shell screen, the nav, settings, content studio, home, inbox, …).
Namespaces used on a single screen span several areas (the shell nav uses `nav`/`common`/`meta`, plus the
screen's own area, plus shared UI from `home`, plus `money`/`currency` formatting labels).

Dictionary sizes (JSON of the objects, measured locally):

| | JSON | br q11 | gzip |
|---|---|---|---|
| `en` | 345 KB | 85 KB | 104 KB |
| `he` | 410 KB | 89 KB | 112 KB |

Per `en` namespace (JSON / br): content 96 / 25 KB · customers 50 / 13 · account 45 / 12 · money 32 / 9 ·
tasks 22 / 6 · billing 21 / 6 · documents 20 / 5 · insights 19 / 6 · inbox 12 / 4 · home 12 / 4 · api 8 / 2 ·
system 5 / 2 · the rest < 2 KB.

## 2. Options considered

| option | HTML cost (en) | first-load cost (en) | repeat-load cost (en) | Hebrew cost | risk |
|---|---|---|---|---|---|
| A. prop from the layout (origin/main) | whole dictionary in **every** document | ≈115 KB br | ≈115 KB br **every** hard navigation | none | none (works) |
| B. bundle `en` into I18nProvider next to `he` | none | +dictionary for **everyone** | cached | **every Hebrew user downloads English** | rejected |
| C. `fetch('/api/i18n/en')` / JSON route on the client | none | +1 request **after** hydration starts | cache depends on headers | none | **flash of Hebrew/untranslated text** and hydration mismatch (SSR HTML is English, the first client render would not be); per-locale response on a dynamic route needs careful CDN keys → **rejected** |
| **D. `en` as its own code-split client chunk, loaded via `next/dynamic` only for English (chosen)** | none | one static JS chunk (≈ dictionary size, br), preloaded from the HTML | **0 bytes** — immutable browser cache until the dictionary changes | none (never referenced) | low — see §4 |
| E. D + split per namespace / per route | none | smaller first load (only the screen's areas) | cached per area | none | navigation into a new area must suspend for its chunk (visible delay or fallback text), every component must declare its areas, a missed area silently renders keys/Hebrew; the shell needs ≥5 areas anyway. Saves only on the **first** load after a deploy that changed `en`. **Not now** (see §5) |

## 3. The change (option D)

- `components/i18n/EnglishI18nProvider.tsx` (new, `"use client"`): statically imports `en`, builds the i18n
  value once, provides it through the same `I18nContext`.
- `components/i18n/I18nProvider.tsx`: `const EnglishI18nProvider = dynamic(() => import("./EnglishI18nProvider"))`
  at module top level; `I18nProvider({ locale, children })` renders the bundled Hebrew value for `he` and the
  lazily loaded English provider for `en` (a typed `Record<Exclude<Locale,"he">, …>` makes any future
  language name its own chunk). The `messages` prop is gone.
- `app/layout.tsx`: `<I18nProvider locale={locale}>` — no dictionary prop, no `getMessages` import.
- `lib/i18n/messages/areas/**`: every area file held its Hebrew AND English objects in ONE module. With
  English out of the client graph (origin/main) Turbopack's unused-export removal dropped the English
  exports from the Hebrew bundle; but once the English chunk imports them, the shared module (both exports)
  lands in the chunk every page loads — the first CI run of this PR measured exactly that (the Hebrew
  pages' shared chunk grew to ≈719 KB raw and carried 57/60 English sentinels, while the English-only
  chunk was 3.5 KB). So each area's English half moved **verbatim** into a sibling `<area>.en.ts`
  (18 files, 35 blocks; types still derived from the Hebrew source via `import type`), and `en.ts`
  imports only those. Proven byte-identical: `JSON.stringify(en)` and `JSON.stringify(he)` are equal
  before/after; the dictionary parity test (30k checks) is unchanged.
- Why this works with Next 16 (node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md and
  `next/dist/shared/lib/lazy-dynamic/loadable.js`):
  - `dynamic()` **inside a Client Component** is code-split ("Load immediately, but in a separate client
    bundle"); from a Server Component it would not be, which is why the boundary lives in `I18nProvider`.
  - `ssr` defaults to `true` and no `loading` is given, so there is **no Suspense fallback**: the server
    renders English HTML completely, and the server-side `PreloadChunks` emits a `<link rel=preload
    as=script>` for the chunk only when the English branch actually renders. During hydration the lazy
    component waits for the (already preloading) chunk while the server HTML stays on screen → no flash,
    and the dictionary object is the same one the server used → no hydration mismatch.
  - The chunk is a normal build asset under `/_next/static/chunks/` with a content hash in its name:
    `Cache-Control: public, max-age=31536000, immutable` (`next start` and Vercel). Its URL changes only
    when its content changes, so deploys can never serve a stale dictionary, and an unchanged dictionary
    stays cached across deploys.
  - The chunk is a static file: same URL and bytes for every English visitor, no cookies, no user or
    business data → CDN caching can never mix users. The locale decision stays in the per-request server
    render (cookie `dz_locale`, read only when `DUBIZ_I18N_ENABLED=true`), exactly as before.
- Hebrew: the `I18nProvider` module gains only the tiny `next/dynamic` loader reference; a Hebrew page never
  renders the English branch, so the chunk is neither preloaded nor fetched. Flag OFF: always Hebrew → never fetched.
- Guards (in `lib/i18n/i18n.verify.test.ts`, run by `i18n-multicurrency-ci.yml`): `getMessages("en") === en`
  (the chunk's object is the server's object), the root layout passes no `messages` and imports no
  `getMessages`, I18nProvider never statically imports a non-Hebrew dictionary, English goes through `next/dynamic`,
  and the static import graph of `he.ts` reaches no `*.en.ts` module and no `Widen<…>` (English) object.

## 4. Risks and how each is covered

| risk | mitigation / proof |
|---|---|
| flash of Hebrew / untranslated text | SSR renders English (no Suspense fallback); proof: rendered DOM/text MAIN = BRANCH on 20 routes × 3 widths (en) |
| hydration mismatch | same dictionary object on server and client; proof: no new hydration console error on BRANCH (identity phase) |
| hydration delayed by a waterfall | chunk preloaded from the HTML (`PreloadChunks`); proof: chunk URL present in the English HTML; DCL/load timings |
| stale dictionary after a deploy | content-hashed filename, immutable; new content ⇒ new URL |
| CDN/browser mixing users or locales | static, cookie-independent asset; proof: identical bytes with/without cookies, same URL for two different English users/businesses, no user data inside |
| Hebrew users paying for English | areas split into `*.en.ts` + graph guard; proof: no Hebrew page (flag ON he / no cookie, flag OFF) requests or references the chunk, no JS a Hebrew page loads carries English sentinels, Hebrew client JS MAIN vs BRANCH within the loader's size |
| a future area file mixing He + En again | the verify-test graph guard fails |
| language switch | `LocaleSettingsForm` does a full `window.location.reload()` → server renders the new locale, the chunk loads (or not) accordingly |
| `(corporate)` marketing pages with an English cookie | unchanged behaviour: they still get the English provider (now as a cached chunk instead of an inline prop) and keep pinning their content to he/rtl |
| rollback | revert the PR (3 files); no data, schema, flag or env involved |

## 5. Why not namespace splitting (option E) now

The chunk is downloaded once per browser per dictionary change; every later English hard navigation costs
0 dictionary bytes. Splitting would only shrink that first download, while adding suspense on navigation into
a new area (a soft navigation would wait for the area chunk or show fallback text), a manifest of areas per
screen that must stay correct by hand, and a silent failure mode (a missed area renders keys/Hebrew). The
shell alone needs several areas, and the largest area (`content`, ≈25 KB br) is a single screen family. Re-evaluate
only if real-user data shows the first English load after a deploy matters.

## 6. Proof (CI: `.github/workflows/i18n-en-chunk-proof.yml` → `.i18n/en-chunk-proof.mts`)

origin/main and this branch, each built flag OFF and flag ON, four `next start` servers side by side on one
runner + ephemeral PG17 (synthetic data). Results: see the PR body (numbers from the CI run) and the
`i18n-en-chunk-proof` artifact (`en-chunk-proof.json` / `.md`).
