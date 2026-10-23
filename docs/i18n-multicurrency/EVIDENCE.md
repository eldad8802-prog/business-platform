# Evidence — languages + multi-currency (branch `feat/i18n-currency-foundation`)

> English activation readiness (every route, Hebrew parity, isolation, public pages, perf, runbook):
> see [ACTIVATION-READINESS.md](ACTIVATION-READINESS.md).

Local runs on Windows (2026-10-22), branch merged with `origin/main` (d207e373+). CI evidence is added
by `.github/workflows/i18n-multicurrency-ci.yml` on the PR (ephemeral PG17).

## 0. CI — ephemeral PG17, run 39779015658 (head 8bca4541): all green
| Step | Result |
|---|---|
| 1 · pure tests | i18n verify 30,126 · money 52 · scenarios 23 · tasks 62/62 · lead history 40 · emails 45/45 · titles + nav pass |
| 2 · DB-backed regression, branch vs `main` on the same database | 65 pass, 7 fail **on `main` too**, **0 new failures** (rls-contract invoice-profile, lead-collision-recovery, lead-w3-closure, identity.db, payables-p46.db, agenda.db, task.db) |
| 3 · multi-currency battery (real routes, real auth, flag OFF) | **25 / 25** |
| 4a · e2e flag ON — signed-in owner, 15 screens × he/en × 390/820/1440, persistence (E2), language changes no data (E3), two businesses / two languages / two currency mixes (E4) | **190 / 190**; English screens with Hebrew still visible: **0** |
| 4b · e2e flag OFF on a production build — cookie ignored, he/rtl, endpoint 404 | **5 / 5** |
| 5 · proposed migration applied + proven + rolled back (throwaway DB) | **27 / 27** + rollback **3 / 3** |

The first four CI runs of this workflow failed in the build step: after `playwright install --with-deps`
the Turbopack build could not resolve the `next/font` (Heebo) files. Both builds now run before the
Chromium install (8bca4541) — a CI-ordering fix only, no app change. `release/verify` (the required build)
was green throughout.

## 1. Static
| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **clean** (exit 0) |
| `lib/i18n/i18n.verify.test.ts` — dictionary parity (he ⇄ en key sets), placeholders, no Hebrew in English, Hebrew money output byte-identical to legacy | **30,078 checks pass** |
| `lib/money/money.verify.test.ts` — exact decimals, no cross-currency arithmetic, conversion refusals | **52 pass** |
| `lib/money/scenarios.verify.test.ts` — partial payments, exchange difference, refund/credit, base vs display, rate updates, stale/missing/unverified | **23 pass** |
| Hebrew byte-identity proofs inside the waves | emails 45/45 (SHA-256 of pre-change renders), tasks 62/62 (hashes of pre-change agenda/queue/cadence), server view-models 75,278 fixture comparisons, documents/billing/money/customers/tasks scripts: every Hebrew dictionary value found verbatim in the pre-change source |

## 2. Regression — every non-DB test in the repo
`345` test files (branch) — **311 pass, 34 fail**. The 34 are **exactly** the set that fails on `main`
(897eeb9a, same machine), proven two ways:
1. each of the 34 was re-run on `main` → fails there too;
2. for the ten that fail on assertions (not on a missing DB), the *set of failure lines* is identical on
   `main` and on the branch (hash compare): mist, ria-policy-lineage, erasure-contract, receipt-issue,
   awaiting-payment rules + serializer, lead-w3-closure, invoice-profile rls-contract, two migration
   grant tests.

| Cause on `main` | Tests |
|---|---|
| need a database (`prisma:error` / `TEST_DATABASE_URL` guard) | 24 — crm ×13, inventory ×8, conversation-state.w25, appointment.qa, billing-issue.tenant-isolation |
| need psql/DB contract fixtures | 3 — billing-invoice-profile.rls-contract, 2 × prisma/migrations grant tests |
| date-dependent (`awaitingSince`) | 2 — awaiting-payment rules, serializer |
| harness flag (`--expose-gc`) | 1 — home-collection-timeline |
| known red contracts on main | 4 — mist (Tailwind token in LeadSourcesPanel), ria @@unique, erasure (73 findings), receipt-issue (`ensureBillingPaymentPostedEvent` import) |

One regression was found during the work and fixed (088ce556: `api/preferences` declared in the
feature-coverage manifest). No new failure remains. The DB-backed tests run for real in CI, branch vs
`main` on the same ephemeral database (`.i18n/regression.sh`).

## 3. Flag OFF = today's behaviour
`.i18n/flag-off-parity.mts`: the same routes served by `main` and by this branch (flag unset), with a
`dz_locale=en` cookie present (must be ignored), compared on `<html lang/dir>`, `<title>` and the visible
text, at 390 px and 1440 px:
- **28 / 30 identical**; the only differences are `/settings/workspace` (the approved new
  "שפה, אזור ומטבע" screen). Two phone-width diffs seen once (`/app`, `/tasks`) were timing flakes —
  identical on two re-runs each.
- CI E5 additionally proves on a production build: cookie ignored (he/rtl), language buttons disabled,
  `POST /api/preferences/locale` → 404.

## 4. English
- 17 main routes render `lang="en" dir="ltr"` with a `dz_locale=en` cookie (flag on); English sidebar,
  English tab titles (e.g. "Invoices · Dubiz"); screenshots during development.
- CI E1 covers 15 signed-in screens × {he,en} × {390, 820, 1440}: lang/dir, no horizontal overflow,
  screenshots uploaded as an artifact; E6 reports any Hebrew still visible in English (excluding data).

## 5. Multi-currency
- Unit: §1 (money + scenarios).
- CI battery (real routes, real auth, ephemeral DB): ILS+USD for one customer → one row per currency,
  ILS headline 1000 (not 1300) flagged mixed; partial ILS payment reduces only ILS; USD payment settles
  in USD; a wrong-currency payment is never allocated; "paid recently" single-currency; thread
  per-currency balances; an ILS-only business sees exactly what it saw before; no cross-tenant reads.
- CI migration proof: the proposed tables with RLS (enabled + forced), CHECKs, base-currency lock,
  append-only rates, runtime read-only on rates, user-preference isolation, rollback.

## 6. Not verified here (and why)
- Signed-in UI with real data **locally**: no approved local database (the other worktrees' `.env` files
  point at remote Neon databases — deliberately NOT used). Covered by the CI e2e on an ephemeral DB.
- Real tablet/phone devices: browser emulation only (Chromium viewports).
- Production: nothing deployed, flag not enabled, migration not applied.
