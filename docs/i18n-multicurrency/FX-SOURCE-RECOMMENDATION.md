# Exchange-rate source — recommendation (NOT activated)

**Recommendation:** use the Bank of Israel (BoI) **representative rates** (שערים יציגים) as the only
`REPRESENTATIVE` source for ILS / USD / EUR. Free, official, no account, no API key, no commercial
commitment. Nothing in this document is enabled; activation needs the owner's approval (§7).

**Status (2026-10-22):** the fetcher is BUILT but NOT ACTIVE — application PR #764 (stacked on the C-2
migration PR #756): parser, client, append-only writer, freshness status and a cron route
(`/api/cron/fx-rates`) that no scheduler calls and that refuses unless `FX_RATES_FETCH_ENABLED=true` and a
writer credential exist. Proven in CI only (`.github/workflows/fx-boi-rates-lab.yml`). Activation steps:
[FX-ACTIVATION-RUNBOOK.md](FX-ACTIVATION-RUNBOOK.md).

## 1. Why BoI
- **Authority:** the representative rate is the reference Israeli accounting and tax practice uses for
  foreign-currency amounts; any other source would need its own justification to an accountant.
- **Cost / risk:** public data, no key to leak, no contract, no rate limit published for this volume
  (2 series × 1 request/day).
- **Scope match:** Dubiz needs exactly USD/ILS and EUR/ILS. USD↔EUR is derived through ILS only when a
  display total needs it (never for accounting).

## 2. Verified endpoint (probed 2026-10-22, read-only GET)
```
https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS?startperiod=YYYY-MM-DD&endperiod=YYYY-MM-DD&format=csv
https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_EUR_ILS?startperiod=…&endperiod=…&format=csv
```
Response columns (CSV): `SERIES_CODE, FREQ, BASE_CURRENCY, COUNTER_CURRENCY, UNIT_MEASURE, DATA_TYPE,
DATA_SOURCE, …, UNIT_MULT, COMMENTS, TIME_PERIOD, OBS_VALUE, RELEASE_STATUS`. Observed: one row per
business day (no Saturday/Sunday/holiday rows), `DATA_TYPE=OF00` (= representative), e.g.
`RER_USD_ILS … 2026-10-21, 3.091`.

**Re-probed 2026-10-22 16:15 UTC** (read-only GET from a developer machine, no key, for the PR): both series
answered `200 text/csv;charset=UTF-8`, exactly the 15 columns above in that order, `FREQ=D`, `DATA_TYPE=OF00`,
`UNIT_MEASURE=ILS`, `UNIT_MULT=0`, `DATA_SOURCE=BOI_MRKT`, `RELEASE_STATUS=YP`, one row per business day
2026-10-12..2026-10-22 (incl. Friday 2026-10-16; none for Sat/Sun), today's rate already present (USD 3.107,
EUR 3.4816). `RER_JPY_ILS` carries `UNIT_MULT=2` (1.9794 = ILS per 100 JPY) — the division rule is real. A window
with **no observations** (a weekend only) answers **404 text/html** (a gov.il error page), not an empty CSV — the
client treats it as a failed fetch. The lab fixtures (`.fxboi/fixtures`) are written in exactly this format.

**Parser rules (each one fails closed):**
- accept only `DATA_TYPE=OF00`, `BASE_CURRENCY ∈ {USD, EUR}`, `COUNTER_CURRENCY=ILS`, `FREQ=D`;
- `OBS_VALUE` parsed as an exact decimal string (never float) and divided by 10^`UNIT_MULT`
  (JPY is published per 100 — irrelevant for USD/EUR today, but the rule must exist);
- `TIME_PERIOD` must be a valid civil date ≤ today (Asia/Jerusalem);
- anything else → the row is rejected and the run is reported, never "best effort".

## 3. Storage (table `FxRate`, migration `20261025090000_currency_settings_fx_rates` — see MIGRATION-RUNBOOK.md)
`kind=REPRESENTATIVE, source=BANK_OF_ISRAEL, rateDate=TIME_PERIOD, rate=numeric(20,10),
verification=VERIFIED, sourceRef=<series code + request URL>`. Append-only for every role incl. the owner (UPDATE / DELETE / TRUNCATE triggers); a correction is a
new row with a later `fetchedAt`; the runtime role can only read. The table also refuses a
Bank of Israel row that is not `REPRESENTATIVE` / quoted in ILS, and a `rateDate` later than `fetchedAt` + 1 day.

## 4. Update mechanism
- **Cron** (Vercel cron, like the existing ones, authenticated with `CRON_SECRET`): once per business
  day at **16:30 Asia/Jerusalem** (BoI publishes the day's rate in the early afternoon), plus one
  retry at **18:00**.
- Each run requests the **last 10 days** (not just today): it back-fills a missed day automatically and
  is idempotent (the unique index on base/quote/kind/source/rateDate/fetchedAt + "skip if an identical
  value already exists for that date").
- **Writer identity:** the NOLOGIN role `fx_rate_writer` (created by the C-2 migration) holds `INSERT` on
  `FxRate` + `USAGE` on its sequence and nothing else — **no SELECT**: the fetcher appends without
  `RETURNING` (Prisma `createMany` or a raw `INSERT`) and checks “identical value already stored” through
  the runtime role's `SELECT`. Its credential is a separate LOGIN member role, created by the owner when
  the fetcher is approved (C-3).

## 5. Failure handling (no silent conversion anywhere)
| Situation | Behaviour |
|---|---|
| BoI unreachable / non-200 / malformed CSV | nothing written; run logged as failed; next run back-fills |
| No rate for today (weekend / holiday / before publication) | conversions use the latest rate within the policy window (`accountingPolicy`: ≤4 days; `displayPolicy`: ≤7 days) |
| Latest rate older than the window | `convert()` returns `RATE_STALE` → UI shows per-currency amounts only ("no verified rate") ; reports mark the total as unavailable |
| Value jumps > 5% vs previous business day | stored as `UNVERIFIED` + alert to the platform admin; accounting policy refuses it until an admin verifies |
| Rate for a FUTURE date | rejected by the parser and by `convert()` (`RATE_FROM_FUTURE`) |
| Duplicate / re-run | no-op (idempotent) |

Monitoring: an admin-visible "last successful rate date" per pair; alert if older than 2 business days.

## 6. What it is used for (and what not)
- **Display totals** (display currency ≠ transaction currency) — marked "≈".
- **Base-currency reports** — only with a verified representative rate of the relevant date.
- **NOT** for tax documents until the accounting rules are approved (rate date for a foreign-currency
  tax invoice, VAT in ILS, uniform-file fields, allocation threshold) — see ARCHITECTURE.md §2.5.
- **NOT** a payment/settlement rate: what a provider actually charged is a `TRANSACTION` rate belonging
  to that transaction.

## 7. To activate (owner decisions)
1. Approve BoI as the source (this document).
2. Approve the C-2 migration (FxRate table + roles).
3. Approve the cron entry + the writer role/credential (FX-ACTIVATION-RUNBOOK.md).
Until then nothing is fetched, stored or converted with real rates.
