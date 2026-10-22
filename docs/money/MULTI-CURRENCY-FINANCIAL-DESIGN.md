# Multi-currency financial data model — design

Status: **PROPOSAL — nothing here is applied, merged or enabled.** Baseline `origin/main` @ `f6c261f9`.
Inputs: [FINANCIAL-DATA-MODEL-AUDIT.md](./FINANCIAL-DATA-MODEL-AUDIT.md) (findings B1–B8, L1, sites M1–M24),
[../i18n-multicurrency/ARCHITECTURE.md](../i18n-multicurrency/ARCHITECTURE.md) (R1–R10, milestones C/D), `lib/money/*` (engine),
the settings + `FxRate` migration being finalised separately as `20261025090000_currency_settings_fx_rates`
(proposal: [../i18n-multicurrency/proposed-migration.sql](../i18n-multicurrency/proposed-migration.sql)).
SQL for this design: [proposed-financial-currency-migration.sql](./proposed-financial-currency-migration.sql) (under `docs/`, not a migration).

**Hard boundaries kept by this design**
- Foreign-currency **tax documents stay blocked** (`billing-draft.service.ts:218` hard-codes ILS) until the accountant rules are
  approved (ARCHITECTURE approval stop 4). Nothing below enables a foreign invoice.
- No change is designed to Israel Tax Authority integrations (allocation numbers, approval payload, uniform file fields) or to
  settlement / provider behaviour. Where this design meets them it **flags** (§9).
- Migration-first: every schema step is a migration-only PR, then a schema + code PR (docs/RELEASE-OWNERSHIP.md).

---

## 1. The three currencies, and where each lives

| layer | meaning | stored where | may change? |
|---|---|---|---|
| **transaction (source) currency** | what the money actually was: the invoice currency, the charge currency, the receipt's currency | `currency` on the row itself | **never** after posting |
| **base currency** | the business's reporting/books currency (ILS for every business today) | `BusinessLocaleSettings.baseCurrency` (absent ⇒ ILS), **and a copy frozen on every posted row** (`baseCurrency`) | the setting only through the controlled lock process; the row copy never |
| **display currency** | what a person chose to *look at* totals in | `BusinessLocaleSettings.displayCurrency` (null ⇒ base) | any time — it never touches stored data |

Rules that follow from the engine (`lib/money`):
1. Rows are never summed across currencies. A total is `sumByCurrency` (or SQL `GROUP BY currency`).
2. A single base-currency total exists only from **frozen base amounts** (stored, never recomputed).
3. A display-currency total is computed at read time with `displayPolicy` and is always marked **≈** (approximate), with its rate date.
4. No silent conversion: a missing / stale / unverified rate is a typed refusal → the UI shows "unavailable", never a number.

## 2. The rate snapshot on a posted row

Every row that **posts money** (an expense/income record, a received or refunded payment, a payables payment, later an issued document)
carries, once posted:

| column | type | meaning |
|---|---|---|
| `currency` | text, CHECK ISO allow-list | transaction currency (already present on 15 tables; **added** to `FinancialRecord`) |
| `baseCurrency` | text | the business base currency **at posting** |
| `baseAmount` | numeric(18,2) NULL | `amount` in base currency, rounded once (HALF_UP, per row — decision D3) |
| `fxRate` | numeric(20,10) NULL | units of base per **one** unit of transaction currency (`1` for identity) |
| `fxRateDate` | date NULL | the civil date (business time zone) the rate is published for |
| `fxRateKind` | text | `IDENTITY` · `REPRESENTATIVE` · `TRANSACTION` (the `lib/money` kinds; `DISPLAY` is **never** stored on a financial row) |
| `fxRateSource` | text | `IDENTITY` · `BANK_OF_ISRAEL` · `PAYMENT_PROVIDER` · `MANUAL` |
| `fxRateId` | int NULL → `FxRate.id` | the reference row used (REPRESENTATIVE only; a TRANSACTION rate is the counterparty's and is stored inline) |
| `baseStatus` | text | `PENDING` (not yet posted) · `FROZEN` · `RATE_UNAVAILABLE` |
| `basePostedAt` | timestamp NULL | when the snapshot was frozen |

Plus, on `FinancialRecord` only: `currencySource` (`BACKFILL_ASSUMED` · `OWNER_ENTERED` · `OCR_DETECTED`) — the backfill is honest
about the fact that old rows were *assumed* ILS (audit §1c).

DB-level invariants (CHECKs + one trigger, SQL file §A):
- `FROZEN` ⇒ every snapshot column is set; `RATE_UNAVAILABLE` ⇒ `baseAmount IS NULL`.
- `currency = baseCurrency` ⇒ `fxRate = 1`, kind/source `IDENTITY`, `baseAmount = round(amount, 2)`.
- `fxRateId` only with `REPRESENTATIVE`; IDENTITY kind ⇔ IDENTITY source.
- **Frozen is frozen:** a trigger refuses any change to the snapshot columns, `currency` or `amount` of a `FROZEN` row. The only
  allowed transition is `PENDING|RATE_UNAVAILABLE → FROZEN`.

## 3. When the base amount is computed and frozen

- **At posting, once.** Posting = the moment the money becomes a fact in Dubiz:
  `FinancialRecord` at document approval (`app/api/documents/[id]/approve/route.ts:277`, same tenant transaction);
  `PaymentTransaction` when stored as `PAID` (incl. negative refund reversals); payables `Payment` when `RECORDED`.
- **Rate:** `currency = baseCurrency` → identity (no rate needed). Otherwise `selectRate(candidates, currency, base, accountingPolicy(relevantDate))`
  → the newest **verified REPRESENTATIVE** rate not after the relevant date and at most 4 days older (weekend/holiday). A provider's
  own settlement rate is recorded as `TRANSACTION` only where the provider states it, and only for that transaction.
- **Relevant date** (decision D2; proposal): FinancialRecord → the document's `date`; PaymentTransaction → the payment's civil date
  (`createdAt` in the business zone); payables Payment → `paidAt`; issued document (tax-gated, later) → the accountant's rule.
- **Never recomputed.** A newer rate, a corrected rate (new `FxRate` row) or a change of the business base currency never rewrites a
  frozen row. Corrections of *amounts* stay what they are today (an approved FinancialRecord is locked; a correction is a new,
  audited event — approved-mutation guard, approve route `:186-218`).

## 4. No verified rate

- The row is stored **in its transaction currency** (the money fact is never lost or blocked), `baseStatus = RATE_UNAVAILABLE`,
  `baseAmount = NULL`.
- Reports show per-currency totals always, and for the base total: **"לא זמין — N רשומות ממתינות לשער"** / "unavailable (N rows awaiting a rate)"
  instead of a number. Never a partial base total presented as complete.
- **Late posting** (decision D12; proposal: allowed): a job (part of the approved BoI fetcher, ARCHITECTURE C-3) re-tries
  `RATE_UNAVAILABLE` rows with the rate of **the row's original relevant date** (BoI publishes history), never today's rate. Success
  → `FROZEN`. If no rate exists for that date window the row stays unavailable and is listed for the owner.
- Tax documents are different: a foreign tax document **without** a verified rate is not issued at all (ARCHITECTURE §2.5 rule 3) — not in scope until D-3.

## 5. Partial payments, refunds, credit notes, mismatches

- **Partial payments.** Each payment posts its own base amount at its own date. Allocations stay in the transaction currency and keep
  today's same-currency rule (`assertSameCurrency`, `planAllocation`). When (later, tax-gated) a foreign invoice has a frozen base at
  issue, the **realised exchange difference** of an allocation = `allocated × paymentRate − allocated × invoiceRate` (in base),
  written to a separate append-only `FxDifference` row (SQL §B). Amounts are never edited to absorb it.
- **Refunds** inherit the original transaction currency (already enforced: `payment-refund.service.ts:362-458` uses `settlement.currency`).
  The negative `PaymentTransaction` reversal posts its own base at the refund date; the difference to the original payment's base is
  an exchange difference (separate row), not a correction of the original.
- **Credit notes** already copy and enforce the source currency (`billing-credit-reversal.service.ts:165,225`). Their base rate
  (original invoice rate vs credit-note date rate) is decision D4; the snapshot lives in the tax-gated document snapshot (§B).
- **Payment currency ≠ invoice currency:** **never allocated silently** — exactly today's behaviour (`payment-accounting-settlement.service.ts:342,394`
  → `VERIFIED_CURRENCY_MISMATCH` / `CURRENCY_MISMATCH`, `planAllocation` throws). Cross-currency settlement, if ever wanted, is an
  explicit owner action with a TRANSACTION rate and an FxDifference row; not designed here.

## 6. Reads: reports, home, exports

**Server shape for every money total** (replaces `{ amount, currency: rows[0].currency }` and bare `_sum`):

```ts
type MoneyTotals = {
  byCurrency: { currency: string; amount: string; count: number }[];        // always
  base: { currency: string; amount: string | null; complete: boolean; missing: number }; // only from FROZEN baseAmount
  display?: { currency: string; amount: string; approximate: true; rateDate: string } | null; // totalIn(displayPolicy), optional
};
```

- SQL: `groupBy({ by: ["currency"], _sum: { amount: true, baseAmount: true }, _count: … })` plus a count of `baseAmount IS NULL`.
  `complete = missing === 0`; `amount = null` when incomplete.
- **Home** (B2): headline = base total when complete and every row's `baseCurrency` equals the current base; otherwise the
  per-currency list. A display-currency figure, when the owner chose one, is shown as `≈` with its rate date.
- **Collection workspace / secretary** (B3, B4): per-currency totals (the collection inbox pattern already in place:
  `collection-inbox.service.ts:381-393`, `isMixedCurrency`).
- **Documents inbox / reports summary / dashboard** (L1): `byCurrency` + base; `profit` only within one currency or in base when complete.
- **Exports / accountant package:** per row add `currency, baseCurrency, baseAmount, fxRate, fxRateDate, fxRateSource` as **appended**
  columns (decision D10 — the accountant may parse fixed positions); workbook totals per currency (SUMIFS by currency) and a base total
  only when complete. CSV column order unchanged up to the new tail.
- **Uniform file / ITA payload: untouched** (tax-gated). B6 is handled by D1 (stop foreign receipts) rather than by changing the file.
- **Learning (CUST-03, DOC-05):** observations are partitioned by currency; a measure is derived only within one currency and stores
  it (`KnowledgeMeasure.detail.currency`, no schema change), so a median never mixes ₪ and $.

## 7. Backfill plan and proof

Order: settings + FxRate migration (`20261025090000_…`) **applied** → this migration (§A) → proof → app PR.

1. `ALTER TABLE … ADD COLUMN currency … DEFAULT 'ILS'` is metadata-only (PG ≥ 11): every existing FinancialRecord reads `ILS` at once,
   with `currencySource = 'BACKFILL_ASSUMED'`.
2. Identity posting, idempotent, only where it is exact:
   `currency = 'ILS'` ∧ business base (settings row, absent ⇒ ILS) = `ILS` ∧ `amount` representable at 2 decimals →
   `baseCurrency='ILS', baseAmount=round(amount::numeric,2), fxRate=1, fxRateDate=<civil date of date in Asia/Jerusalem>, kind/source IDENTITY, FROZEN`.
3. Anything else stays `PENDING` and is **counted** by the proof (float-inexact amounts, a non-ILS base already chosen).
4. `PaymentTransaction` / payables `Payment`: same identity rule for ILS rows; non-ILS rows (code-possible, expected 0 in Production)
   → `RATE_UNAVAILABLE` until the late-posting job finds the historical representative rate.
5. Rows written by **old code** between the migration and the app PR get `PENDING` (defaults) — the same idempotent statement is re-run
   after the app deploy (or the app posts them lazily). No gap is silent: the proof's `PENDING` count shows it.
6. Issued `BillingDocument` rows are **not updated** (the `secf_fiscal_immutable` trigger forbids it, rightly). Their base, when the
   tax-gated phase comes, goes to a separate append-only `BillingDocumentFxSnapshot` (SQL §B) — identity rows for ILS documents are
   INSERTs there, never UPDATEs of the document.

**Proof query set** (aggregates and booleans only — evidence-output guard: no row data in logs) — SQL file §C:
- Q1 rows by (`currency`, `currencySource`, `baseStatus`) per table.
- Q2 `FROZEN ∧ currency='ILS'` with `baseAmount <> round(amount::numeric,2)` or `fxRate <> 1` → **0**.
- Q3 Σ`amount` = Σ`baseAmount` over identity rows, per business (returns only the count of businesses where it differs → **0**).
- Q4 `PENDING` count with reason buckets (float-inexact / base ≠ ILS / written after backfill).
- Q5 suspect foreign FinancialRecords: count of approved rows whose `Document.ocrText` matches `\$|€|USD|EUR|dollar|euro` (owner-run
  listing of ids only outside CI).
- Q6 non-ILS `PaymentTransaction` / `BillingDocument` counts (B1 detector; expected 0).
- Q7 trigger proof on a throwaway database: updating a frozen `baseAmount` / `amount` / `currency` fails; `PENDING → FROZEN` works.
- Q8 rollback: the down script removes columns/constraints/trigger and leaves every original column byte-identical (checksum of
  `id, amount, date, vendorName, direction, category` before/after).

## 8. The guard (shipped in this PR)

`scripts/ci/cross-currency-sum-guard.mjs` + `scripts/ci/cross-currency-sum-guard.baseline.json`.
- Reads the guarded money columns from `prisma/schema.prisma` (numeric money fields of models with a `currency` column, plus
  `FinancialRecord.amount`). Rules: `PRISMA_SUM`, `JS_FOLD`, `JS_ACCUMULATE`, `SQL_SUM`, `FIRST_ROW_CURRENCY`; a site is exempt when
  the call (or the 3 lines above it) is grouped/filtered by `currency` or goes through `lib/money`.
- 55 current findings are baselined with risk + reason (SAFE 28 · LATENT 12 · BROKEN 15). NEW finding → FAIL; STALE entry → FAIL;
  entry without risk/reason → FAIL. Matching is by (file, rule, normalised line), not line numbers.
- `--self-test` (31 cases: every rule can fail, every exemption holds, baseline new/stale/invalid). Deterministic, no network.
- **CI wiring:** a **report-only** step (`continue-on-error: true`) in `.github/workflows/security-gate.yml`, beside the other static
  guards that run on every PR. It is *not* added to `release-ci-verify.yml` (RELEASE-OWNERSHIP forbids feature sessions editing
  `release-*.yml`) and it is *not* blocking, because `security/gate` is a required check and a new merge blocker is an owner policy
  decision (D9). To make it blocking: delete the one `continue-on-error` line.
- Limits: text scanner, not a type checker; it cannot prove "one invoice" (the baseline reason does); it misses sums through renamed
  values (`amountMinor`, `outstanding`) and helpers taking plain numbers (`sumDecimal2`) — those are audit §2c and are fixed by the
  phases below, not by the guard; a non-money `amount` can collide (resolved in the baseline).

## 9. Flags (interactions this design does not change)

- **B1 — foreign-currency receipts via settlement.** The cleanest containment, consistent with "foreign tax documents stay blocked",
  is that settlement pauses (`REQUIRES_ATTENTION`) instead of issuing a non-base-currency receipt, and/or standalone payment
  requests are limited to the base currency until D-3. Either is a settlement/provider behaviour change → **owner decision D1**, own PR.
- **R1/R3/R4** (ITA threshold, uniform fields 1032/1422/1423, approval payload) — remain tax-gated (D-3).
- **B7** bank line → payment currency relabel: payables behaviour change (refuse when `line.currency ≠ commitment.currency`) → D14, own PR.
- **R10** OCR currency detection — prerequisite for letting a FinancialRecord be non-ILS from intake (D6).

## 10. Phased PR plan (migration-first)

| phase | PR | content | risk | tests |
|---|---|---|---|---|
| **0** | this PR (docs + guard) | audit, design, proposed SQL, guard report-only | none (no runtime change) | guard self-test; security-test-coverage; tsc |
| **A1** | app only, no schema | fix B2/B3/B4 with `groupBy(["currency"])` / per-currency maps; API returns `byCurrency` (+ the existing single-currency fields unchanged for ILS-only data); remove their baseline entries | low–medium: API shape additive; ILS-only output byte-identical | unit tests per service (mixed ILS+USD fixtures → never one number); existing home/collection/secretary tests unchanged; e2e flag-OFF identical |
| **A1b** | app only | B5/R7: a receipt payment line must be in the receipt's currency (validation refusal); B8: matching only within one currency | medium (new refusal) | receipt draft/issue tests; matching tests |
| **D1** | owner decision → app | B1 containment (settlement pause or base-only standalone requests) | medium (payment flow) | settlement battery (C3 CI) with a USD verified payment |
| **M1** | **migration only** (`prisma/migrations/<ts>_financial_currency_snapshot`) | SQL §A: FinancialRecord currency + snapshot, PaymentTransaction + Payment snapshot, CHECKs, freeze trigger, identity backfill | low (additive; defaults; metadata-only ADD COLUMN; backfill UPDATE on FinancialRecord/PaymentTransaction/Payment only) | ephemeral PG17 lab: apply, Q1–Q8, rollback; tenant-table-rls guard; release-migrate preflight + post-apply evidence workflow |
| **A2** | schema + code | `schema.prisma` fields; approve route posts identity snapshot in its tx; payment store / payables post snapshots; reads use `baseAmount`; L1 sites switch to `byCurrency` + base; remove LATENT FinancialRecord baseline entries | medium (write path of approval) | approve route tests (atomicity unchanged), RLS battery, regression branch-vs-main |
| **A3** | app | review UI: currency selector for expense/income documents (ILS default), OCR currency hint (R10), `RATE_UNAVAILABLE` UI | medium | review E2E he/en; non-ILS approval stores currency + unavailable base |
| **C-3** | separate (already pending) | BoI fetcher + late-posting job | medium (cron/writer role) | fetcher tests, staleness, late posting uses original date |
| **A4** | app | display currency `≈` totals (displayPolicy), settings live currency choice (milestone E) | low | display totals marked approximate; refusal paths |
| **A5** | app | exports + accountant ZIP: appended columns, per-currency workbook totals | low–medium (accountant format) | export snapshot tests; accountant review |
| **M2/A6** | migration → code, **tax-gated (D-3)** | SQL §B: `BillingDocumentFxSnapshot`, `FxDifference`; issue-time snapshot; R1/R3/R4 | high (tax) | full billing batteries, uniform simulator, accountant sign-off |
| **G** | owner decision | guard blocking (remove `continue-on-error`) | policy | — |

## 11. Decisions needed (owner / accountant)

| # | decision | who | proposal |
|---|---|---|---|
| D1 | Contain B1 (foreign receipts via settlement): pause settlement for non-base currency, or restrict standalone requests to base currency, until D-3 | owner | pause settlement (`REQUIRES_ATTENTION`), keep requests as they are |
| D2 | Relevant date of the representative rate per row type (doc date / payment date / issue date / "last known rate" rule) | accountant | as §3 |
| D3 | Rounding: per row, HALF_UP, 2 decimals | accountant | yes |
| D4 | Credit-note base rate: original invoice rate vs credit-note date | accountant | original invoice rate |
| D5 | Exchange differences: where they appear (report line, accountant package) | accountant | separate FxDifference rows + a report section |
| D6 | May a FinancialRecord be non-ILS from intake (UI selector + OCR detection)? | owner | yes, after A2, default ILS |
| D7 | Backfill marker `BACKFILL_ASSUMED` + owner review of Q5 suspects | owner | yes |
| D8 | Display-currency rates: DISPLAY kind, indicative, ≤ 7 days | owner | as `displayPolicy` |
| D9 | Cross-currency guard: report-only vs blocking in `security/gate` | owner | blocking after A1 lands |
| D10 | Appending currency/base columns to CSV + accountant workbook | accountant | append at the end |
| D11 | FX source = Bank of Israel (already pending, C-3) | owner | BoI |
| D12 | Late posting of `RATE_UNAVAILABLE` rows with the original-date rate | accountant | allowed |
| D13 | Base-currency lock: lock at the first posted row (settings `baseCurrencyLockedAt`) | owner | yes |
| D14 | B7: refuse recording a bank line against a commitment in another currency | owner | refuse |
| D15 | Foreign-currency tax documents (rate date, VAT in ILS, uniform 1032/1422/1423, ITA payload, threshold) | accountant + owner | unchanged: blocked until approved |
