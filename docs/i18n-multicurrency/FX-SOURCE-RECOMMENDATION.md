# Exchange-rate source — recommendation (NOT activated)

**Recommendation:** use the Bank of Israel (BoI) **representative rates** (שערים יציגים) as the only
`REPRESENTATIVE` source for ILS / USD / EUR. Free, official, no account, no API key, no commercial
commitment. Nothing in this document is enabled; activation needs the owner's approval (§7).

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

**Parser rules (each one fails closed):**
- accept only `DATA_TYPE=OF00`, `BASE_CURRENCY ∈ {USD, EUR}`, `COUNTER_CURRENCY=ILS`, `FREQ=D`;
- `OBS_VALUE` parsed as an exact decimal string (never float) and divided by 10^`UNIT_MULT`
  (JPY is published per 100 — irrelevant for USD/EUR today, but the rule must exist);
- `TIME_PERIOD` must be a valid civil date ≤ today (Asia/Jerusalem);
- anything else → the row is rejected and the run is reported, never "best effort".

## 3. Storage (proposed table `FxRate`, docs/i18n-multicurrency/proposed-migration.sql)
`kind=REPRESENTATIVE, source=BANK_OF_ISRAEL, rateDate=TIME_PERIOD, rate=numeric(20,10),
verification=VERIFIED, sourceRef=<series code + request URL>`. Append-only (trigger); a correction is a
new row with a later `fetchedAt`; the runtime role can only read.

## 4. Update mechanism
- **Cron** (Vercel cron, like the existing ones, authenticated with `CRON_SECRET`): once per business
  day at **16:30 Asia/Jerusalem** (BoI publishes the day's rate in the early afternoon), plus one
  retry at **18:00**.
- Each run requests the **last 10 days** (not just today): it back-fills a missed day automatically and
  is idempotent (the unique index on base/quote/kind/source/rateDate/fetchedAt + "skip if an identical
  value already exists for that date").
- **Writer identity:** a dedicated DB role with `INSERT` on `FxRate` only (no tenant tables) — created
  together with the fetcher, not by the runtime.

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
3. Approve the cron entry + the writer role/credential.
Until then nothing is fetched, stored or converted with real rates.
