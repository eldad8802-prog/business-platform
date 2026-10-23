# Bank of Israel rates — activation runbook (owner steps; NOTHING here is done yet)

The fetcher is built and proven in CI (`.github/workflows/fx-boi-rates-lab.yml`), but it is **inert**: no
scheduler calls it, the route refuses unless `FX_RATES_FETCH_ENABLED=true`, and the writer has no credential.
Nothing in the application converts money with these rates — storing them changes no amount anywhere.

| Piece | Where |
|---|---|
| Parser (fail-closed) | `lib/fx/boi-parser.ts` |
| HTTP client (timeout, no retry, no redirects, size cap, text/csv) | `lib/fx/boi-client.ts` |
| Writer (INSERT-only role, idempotent, jump ⇒ UNVERIFIED) | `lib/fx/fx-rate-writer.ts` + `lib/prisma-fx-writer.ts` |
| One run (both pairs, last 10 days) | `lib/fx/fx-rates-run.ts` |
| Route (CRON_SECRET + enable flag) | `app/api/cron/fx-rates/route.ts` — `GET` (Vercel cron) / `POST` (manual) |
| Freshness status (library only) | `lib/fx/fx-rate-status.ts` |

## 0. Preconditions
1. Migration `20261025090000_currency_settings_fx_rates` (PR #756) is merged and **applied** to Production
   through release-migrate, and its production evidence passes (MIGRATION-RUNBOOK.md §3–§5).
2. This application PR is merged to `main` **after** that (migration-first rule) and deployed. Merging it
   without the migration applied is still harmless at runtime (the route answers 404 until enabled), but the
   migration-first guard blocks the merge until the migration is on `main`.

## 1. Create the writer login (owner, Neon SQL editor, as the migration/owner role)
```sql
-- A LOGIN member of the NOLOGIN group fx_rate_writer (INSERT on "FxRate" + USAGE on its sequence, nothing else).
CREATE ROLE fx_rate_writer_prod LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<generate ≥ 32 random chars>' IN ROLE fx_rate_writer;
-- The role needs USAGE on schema public to reach the table (preflight check 18 says whether PUBLIC has it):
-- GRANT USAGE ON SCHEMA public TO fx_rate_writer;   -- only if check 18 reported that PUBLIC does NOT
```
Verify: `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'fx_rate_writer%';`
→ the group NOLOGIN, the member LOGIN, neither super nor bypass. Note: the rollback (`.fx/rollback.sql`)
refuses while a LOGIN member of `fx_rate_writer` exists — drop `fx_rate_writer_prod` first if you ever roll back.

## 2. Store its connection string (owner, Vercel → Project → Settings → Environment Variables, Production only)
- `FX_RATE_WRITER_DATABASE_URL` = the Neon **pooled** URL of `fx_rate_writer_prod` (`sslmode=require`).
  It must differ from `DATABASE_URL` / `DIRECT_URL` / the admin and auth URLs — the writer refuses a URL equal
  to any of them, and there is no fallback: unset ⇒ the route answers 503 `fx_rate_writer_not_configured`.
- Do not add it to Preview / Development.

## 3. Enable the route
- `FX_RATES_FETCH_ENABLED` = `true` (exactly; anything else = 404). Redeploy (env vars apply to new deployments).
  Check the Production alias serves the new deployment — auto-deploys can lag or land out of order.

## 4. First manual run (before any schedule)
```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://promaxgroup.co.il/api/cron/fx-rates | jq
```
Expected: HTTP 200, `ok: true`, per pair `fetched` ≈ 6–8 (business days in the last 10), `inserted` = `fetched`,
`unverified: 1` (the oldest day has no earlier rate to compare against — `FX_RATE_NO_BASELINE`, by design),
`rejected: 0`. Run it again: `inserted: 0`, `skipped` = `fetched` (idempotent). Read the rows (read-only):
```sql
SELECT "base", "rateDate", "rate", "verification", "fetchedAt" FROM "FxRate" ORDER BY "base", "rateDate", "fetchedAt";
```
and compare two of them with boi.org.il (שערים יציגים) by eye.

## 5. Schedule it (owner, a separate PR to `vercel.json`)
Vercel cron schedules are **UTC** and do not follow Israel's DST. Israel = UTC+3 (IDT, late March → late
October) and UTC+2 (IST, winter). BoI publishes the day's rate in the early afternoon, so pick UTC times that
land after publication in both seasons:

| Intended (Asia/Jerusalem) | Summer (IDT, UTC+3) | Winter (IST, UTC+2) | Proposed fixed UTC entry |
|---|---|---|---|
| 16:30 | 13:30 UTC | 14:30 UTC | `30 13 * * 1-5` → 16:30 summer / 15:30 winter |
| 18:00 (retry) | 15:00 UTC | 16:00 UTC | `0 16 * * 1-5` → 19:00 summer / 18:00 winter |

```json
{ "path": "/api/cron/fx-rates", "schedule": "30 13 * * 1-5" },
{ "path": "/api/cron/fx-rates", "schedule": "0 16 * * 1-5" }
```
Both runs are idempotent, so the second is a no-op on a normal day and the back-fill on a bad one; the
10-day window also back-fills weekends, holidays and any missed day. (Fridays: BoI sometimes publishes — the
schedule covers Mon–Fri; a Friday rate missed by the Friday runs is picked up on Monday.) Vercel cron sends
`GET` with `Authorization: Bearer $CRON_SECRET` — the existing secret; nothing new to configure.

## 6. Monitoring
- Every run logs `[fx-rates] …` (Vercel logs). Alerts are `console.error` lines `[fx-rates] alert` with
  `event`: `FX_RATE_JUMP` (> 5 % vs the previous business day — stored **UNVERIFIED**; the accounting policy
  refuses it), `FX_RATE_NO_BASELINE` (no earlier rate within 10 days — UNVERIFIED), and, as a warning,
  `FX_RATE_REVISED` (BoI changed a published value — a new row, the old one kept). Failures:
  `fetch_failed` (`TIMEOUT`, `HTTP_STATUS` — BoI answers **404 text/html when the window has no data**,
  `REDIRECT`, `CONTENT_TYPE`, `TOO_LARGE`, `NOT_UTF8`) and `parse_rejected`; the run answers 500 so the cron
  shows red, and the pair's rows are not written at all.
- Freshness: `getFxRateStatus()` (`lib/fx/fx-rate-status.ts`) gives per pair the latest rate date, the
  latest VERIFIED date, and `stale` = more than 2 business days (Mon–Fri) since the last verified rate. No
  route exposes it yet; wiring it into the platform-admin view is a separate decision (new admin authority).
  Until then: the SQL above.

## 7. Failure handling
| Situation | What you see | What to do |
|---|---|---|
| BoI down / slow / format change | 500, `fetch_failed` / `parse_rejected`; nothing written | nothing — the next run back-fills 10 days; if it persists for 2 business days, check the endpoint by hand (FX-SOURCE-RECOMMENDATION.md §2) |
| `FX_RATE_JUMP` | row stored UNVERIFIED | compare with boi.org.il; if genuine, an admin-verified row is a future feature — until then accounting refuses it and display marks it "≈" |
| BoI revised a value | `FX_RATE_REVISED`; new row with later `fetchedAt` | nothing — readers take the newest row |
| A wrong value got in | — | rows are append-only for every role; removal is an owner-run script (MIGRATION-RUNBOOK.md §1 "FxRate append-only — the documented exception") |
| 503 `fx_rate_writer_not_configured` / `…_misconfigured` | nothing fetched | step 2 |

## 8. Disable
Unset `FX_RATES_FETCH_ENABLED` (or set anything but `true`) and redeploy → the route answers 404 before any
fetch or database access. Removing the `vercel.json` entries stops the calls; dropping the writer login
(`DROP ROLE fx_rate_writer_prod;`) and unsetting `FX_RATE_WRITER_DATABASE_URL` removes the credential.
Stored rows stay (append-only; nothing reads them for money yet).

## Owner decisions this runbook needs
1. Go for steps 1–4 (writer login + env vars + first manual run).
2. The schedule (two Mon–Fri UTC entries above, or other times).
3. Whether the oldest day of the very first run being UNVERIFIED (no baseline) is acceptable — it is ~10 days
   in the past at activation and never used for "today".
4. Where alerts go beyond Vercel logs, and whether the status gets an admin view.
