# Payment settlement facts — charged / received / fee / net per payment

Status: **design + migration-only PR** (`20261026090000_payment_settlement_facts`). Nothing is applied anywhere,
no runtime code reads or writes the new table, `schema.prisma` is unchanged. Applying the migration in Production
is a separate owner gate (release-migrate), and so is every application PR below.

## 1. The problem

For a payment in USD / EUR (or ILS) the owner must be able to see, each with where the number came from:

| What | Example (USD card payment) | Today |
|---|---|---|
| **Charged** — what the customer paid | 100.00 USD | `PaymentTransaction.amount` + `currency` (verified from CardCom `Amount` + `CoinId`) |
| **Received / settled** — what the provider credited | 370.00 ILS | not stored |
| **Conversion rate** — the provider's own | 3.70 ILS per USD | not stored |
| **Fees** — what the provider kept | 15.00 ILS | not stored |
| **Net** — what reached the business's bank | 355.00 ILS | not stored |

`PaymentTransaction` (prisma/schema.prisma) has only `amount`, `currency`, `status`, `rawPayload`. The CardCom
adapter (`lib/services/payments/providers/cardcom/cardcom.provider.ts`) extracts only `TransactionInfo.Amount`
and `CoinId`; whether CardCom's API exposes fee / net / deposit data is **unknown** (no CardCom documentation in
the repository — §8 lists what to ask). Reversals are already `PaymentTransaction` rows with a **negative**
amount in the payment's own currency (`payment-refund.service.ts`: "A reversal is a settled row with a negative
amount"; it always writes `currency: settlement.currency`).

Non-negotiable: a Bank of Israel representative rate (or any computed / display rate) is **never** stored or
shown as a received amount. Received means "the provider or the bank said so", or "the owner typed what they see".

## 2. Model choice: one append-only row per fact version

**Chosen:** a separate table `"PaymentSettlementFact"`, one row per *fact version* about one `PaymentTransaction`,
`kind` ∈ `CHARGED | SETTLED | FEE | NET`.

**Rejected: one row per transaction with nullable columns** (`settledAmount`, `feeAmount`, `netAmount`, …).
It would make `net = settled − fee` a plain CHECK, but:

* **provenance is per number, not per row.** The typical real case mixes sources: the fee comes from the
  provider's report, the net from the bank line, the settled amount from the provider. One `source` column per
  row cannot say that; a `source` column per number is the per-kind design with extra steps;
* **numbers arrive at different times** (charged at checkout, settled / fee at the provider's batch, net days
  later at the deposit). A wide row is either updated in place (no history, not append-only) or copied whole on
  each arrival (every version restates numbers it did not observe);
* **corrections are per number.** A wrong fee is superseded alone; the settled amount keeps its source and time.

**Rejected: columns on `PaymentTransaction`.** It is the verified clearing record (fiscal evidence, unique on
`(provider, providerTransactionId)`), written once by the webhook; settlement facts arrive later from other
sources and must be versioned. Mixing the two would make the clearing record mutable.

### Columns

| Column | Type | Meaning |
|---|---|---|
| `id` | serial | |
| `businessId` | int, FK Business RESTRICT | tenant key (RLS) — must own the transaction (enforced) |
| `paymentTransactionId` | int, FK PaymentTransaction RESTRICT | the settlement **or reversal** row the fact is about |
| `kind` | text CHECK | `CHARGED` / `SETTLED` / `FEE` / `NET` |
| `amount` | numeric(18,2) | signed, see §3 |
| `currency` | text CHECK `ILS`/`USD`/`EUR` | the currency of **this** number (the money engine's registry) |
| `providerRate` | numeric(20,10) null | the provider's conversion rate (only on `SETTLED`) |
| `rateBase` / `rateQuote` | text null | `providerRate` units of `rateQuote` for ONE `rateBase` (same convention as `lib/money/fx.ts`); base = the charged currency, quote = the settled currency |
| `source` | text CHECK | `PROVIDER` / `BANK` / `MANUAL` — there is **no** value for a representative / computed / display rate |
| `sourceRef` | text null (≤512) | the provider's reference (deal / deposit / report id); **required for PROVIDER** |
| `externalTransactionId` | int null, FK ExternalTransaction RESTRICT | the matched bank line; **required iff BANK** |
| `occurredAt` | timestamp null | when the money moved, per the source (value date / settlement date) |
| `note` | text null (≤1000) | **required for MANUAL** and for a **review clearance** (what was looked at: the data source / evidence) |
| `idempotencyKey` | text null (≤200) | unique per business — a re-delivered observation is the same fact |
| `supersedesId` | int null, FK self RESTRICT | the fact this version corrects |
| `verification` | text NOT NULL CHECK | `VERIFIED` / `NEEDS_REVIEW` — always stated by the writer (no default). There is **no** "estimated" / "representative" value |
| `reviewReason` | text null CHECK | required iff `NEEDS_REVIEW`, one of `NET_MISMATCH` / `CURRENCY_MISMATCH` / `SOURCE_CONFLICT`; null iff `VERIFIED` |
| `recordedByUserId` | int null, FK User SET NULL | who recorded it — a user **of the row's business** (enforced); **required at insert for MANUAL and for a review clearance**; blanked on user erasure |
| `recordedAt` | timestamp | always the database's clock (the guard overwrites whatever the writer sent) |

The three sources map to what exists:

* **PROVIDER** — parsed from the provider's data (webhook payload, transaction query, deposit / settlement
  report). Only what the provider *states*; an implied rate (settled ÷ charged) is never stored as `providerRate`.
* **BANK** — a matched incoming bank line. Incoming deposits **are** modelled: `ExternalTransaction` with
  `direction = CREDIT` (Accounts Payable phase 5, `lib/services/payables/payables-observation.service.ts`), fed by
  `OWNER_ENTRY` / `OWNER_UPLOAD` today and `BANK_FEED` / `PROVIDER` later. Its facts are immutable by trigger and
  its amount is positive; a BANK fact must be in the bank line's own currency and of the same business. A deposit
  is usually a **batch** of many payments, so the bank line's amount is not compared to the fact's amount; the
  per-payment NET of a batch is a PROVIDER number (the provider's deposit report) or MANUAL.
* **MANUAL** — the business owner (or, once a member model exists, a user holding the financial permission
  `payments.settlement.record`, §11.2) typed it from the provider's back office or a statement, with a note naming
  the data source; audited by the row itself (who = `recordedByUserId`, when = `recordedAt`, the database's clock,
  data source = `note`, what it replaced = `supersedesId`) and, in the application PR, a `PaymentAuditEvent`.

## 3. Invariants (all enforced in the database, all proven in the lab)

1. **Tenant:** RLS ENABLED + FORCED; a read policy and an append policy on `businessId` = tenant GUC; no change
   or removal policy.
2. **The transaction belongs to the row's business** — compared explicitly in the guard (through
   `PaymentTransaction → PaymentRequest.businessId`), so it holds for a BYPASSRLS writer too, not only via RLS.
   For the runtime, another business's transaction is simply invisible and refused the same way.
3. **Only a `PAID` transaction has facts.**
4. **`CHARGED` = the transaction's own amount and currency.** A refund therefore keeps the original currency.
5. **Signs follow the money:** on a payment (positive transaction) `CHARGED` / `SETTLED` are positive and `NET` is
   positive or zero; on a reversal (negative transaction) they are negative (or `NET` zero). `FEE` is positive
   when the provider kept money, negative when it gave a fee back. `CHARGED` / `SETTLED` are never zero.
6. **Rate:** all of `providerRate` / `rateBase` / `rateQuote` or none; only on `SETTLED`; `> 0`; base ≠ quote;
   quote = the settled currency; base = the charged currency. No rate on a same-currency settlement.
7. **Sources carry evidence:** PROVIDER → `sourceRef`; BANK ⇔ `externalTransactionId` (same business, same
   currency); MANUAL → `note` + `recordedByUserId` (a user of the same business — refused for a user of another
   business, also for a BYPASSRLS writer); `CHARGED` never from BANK.
8. **NET = SETTLED − FEE, or all three under review** — among the *current* facts of a transaction, **when all
   three are in one currency** and NET ≠ SETTLED − FEE, every one of the three must be `NEEDS_REVIEW`; a
   `VERIFIED` fact among them is refused. Checked at **commit** (a deferred constraint trigger, so the three — or a
   correction of two, or the NEEDS_REVIEW restatement of the others — can be written in one transaction). A
   disagreement is therefore **always storable and never verified**. Across currencies **nothing is computed** and
   nothing is refused (a writer may still flag `CURRENCY_MISMATCH`).
8a. **Review clearance** — a `VERIFIED` fact superseding a `NEEDS_REVIEW` one names `recordedByUserId` (a user
   of the business) and carries a `note`; an automatic (user-less) clearance is refused. After a clearance the
   invariant 8 still holds: a clearance that leaves the set contradicting is refused.
   Concurrent writers of one transaction's facts are serialised by a transaction-scoped advisory lock, and facts
   are written only under READ COMMITTED, so the commit-time check always sees the other writer's committed rows
   (the lab proves this with a real two-session race).
9. **Append-only for every role** (UPDATE / DELETE / TRUNCATE refused by trigger — owner and superuser too; the
   runtime has no such privilege at all) — a review is never cleared in place. The single exception is the FK
   action blanking `recordedByUserId` when a user is erased; the actor rules (7, 8a) are checked when a row is
   written, so an erased user's MANUAL facts and clearances stay valid rows (the lab proves both). Financial parents (business, transaction, bank line, superseded fact) cannot be deleted under a
   fact (RESTRICT).
10. **Versions:** one first version per (transaction, kind); each fact superseded at most once; a correction must
    be the same transaction and kind ⇒ every kind is one linear chain with exactly one **current** fact (the one
    nothing supersedes).

## 4. Refunds, partial payments, credits

* **Partial payment** — each settled movement is its own `PaymentTransaction`; each gets its own facts. Nothing to
  add.
* **Refund / void** — a reversal `PaymentTransaction` (negative, original currency). Its facts:
  `CHARGED −40.00 USD` (equals the reversal), `SETTLED −148.40 ILS @ 3.71` (what the provider debited, possibly at
  a different rate than the payment), `FEE` (a refund fee, or a negative fee if the provider returned part of its
  fee), `NET −148.40 ILS`. The original payment's facts are never touched.
* **Credit note** — a billing document (`BillingDocument`), not a money movement: it keeps the original currency
  there and gets no settlement facts until money actually moves (a reversal).

## 5. How the UI labels each number

| Number | Label | Rule |
|---|---|---|
| CHARGED | "חויב" — `100.00 $` | always exact; source = the provider's verification |
| SETTLED | "התקבל אצל הסולק" — `370.00 ₪` + source chip (סולק / בנק / הוזן ידנית) | only from a SETTLED fact |
| Rate | "שער הסולק: 3.70" | only `providerRate`; never a Bank of Israel rate |
| FEE | "עמלה" — `15.00 ₪` | only from a FEE fact; "derived" (`SETTLED − NET`, same currency, exact arithmetic) is shown as **מחושב** with both inputs on hover |
| NET | "הועבר לחשבון" — `355.00 ₪` | only from a NET fact |
| Needs review | the number + "דורש בדיקה" chip + the reason (נטו לא תואם / מטבע לא תואם / מקורות סותרים) | shown with its source, **never** as verified and never in a verified total; clearing it is a new fact by the owner (§11.2) |
| Missing | "טרם התקבל מידע מהסולק" | never filled with an estimate |
| Estimate | `≈ 368 ₪` "הערכה לפי שער יציג של בנק ישראל, לא סכום שהתקבל" | **never stored** (no source / verification / kind can hold it — the lab proves it); computed at display time only, for information only; **visually distinct** (muted, ≈, its own line, tooltip), **never** in a "received" / "net" slot, **never** part of the received or net totals. The application PR must render it in its own component and test that no total includes it |

Every number has a source line: provider (+ reference), bank line (date + bank account), or manual (who, when,
note). A superseded value is visible in the history ("עודכן מ־368.00").

## 6. Home / collection summaries

* An **ILS received total** sums only the *current*, **`VERIFIED`** `SETTLED` (or `NET`, for "transferred")
  facts whose `currency = 'ILS'`. Index `(businessId, kind, currency)` serves it. A current `NEEDS_REVIEW` fact
  is not in it: it is listed separately as attention ("₪ 97 דורש בדיקה"), from the partial index
  `(businessId) WHERE verification = 'NEEDS_REVIEW'`.
* Payments without such a fact are **not** in that total. They are shown **per currency** from `CHARGED`
  (`sumByCurrency` in `lib/money/aggregate.ts`), e.g. "₪ 12,400 התקבל · $ 300 + € 120 ממתינים לנתוני סליקה".
* A representative-rate equivalent of the foreign part may be shown only as a separate, clearly marked
  `≈` line (convert via `lib/money/fx.ts` with an explicit REPRESENTATIVE policy, `approximate: true`), never added
  to the received total and never labelled received.
* Reversals subtract naturally (negative facts), in their own currencies.

## 7. Dependency on the currency migration

This migration has **no object dependency on** `20261025090000_currency_settings_fx_rates` (branch
`db/currency-fx-migration`) and names none of its objects (the lab asserts it). The **release order is still
fixed**: `20261025090000` first, then `20261026090000` — the only order in which both preflights pass unchanged.
The analysis, the inverted-order consequence and the gates are in [MIGRATION-ORDER.md](MIGRATION-ORDER.md).

## 8. What is needed from CardCom (owner to ask CardCom support)

1. **Foreign-currency terminal:** is our terminal enabled to charge in USD and EUR? Is a separate terminal /
   agreement needed per currency?
2. **Settlement currency:** in which currency is the merchant settled for a USD / EUR charge — ILS after
   conversion, or a foreign-currency account? Can it differ per card brand / acquirer (Isracard, Cal, Max)?
3. **Conversion rate:** who converts (acquirer or CardCom), at which rate (acquirer rate / representative rate +
   spread), and **when** (charge date or deposit date)? Is the applied rate returned by any API?
4. **Fees:** does any API (transaction info, `GetTransactionInfoById`, deposit / settlement reports) return the
   fee per transaction (clearing commission, foreign-card / currency-conversion fee, CardCom fee), and in which
   currency?
5. **Net / deposit:** is there an API or export of deposits (date, amount, list of transactions in the batch),
   so a bank line can be split into per-payment NET?
6. **EUR coin id:** the adapter uses ISO numeric `978` for EUR (`ISO_COIN_ID`, marked DOCS-CONFIRM) and CardCom's
   own `1` = ILS, `2` = USD. Confirm the EUR value for both request (`ISOCoinId`) and response (`CoinId`).
7. **Refunds in foreign currency:** is a refund of a USD charge debited in USD or ILS, at which rate, and is any
   fee returned? Can a refund be queried back by `ExternalRefundDealId`?
8. **Timing:** how many days from charge to deposit (per brand / installments), and are installment payments
   deposited per installment?

Until answers exist: the PROVIDER source is used only for what the current adapter verifies (CHARGED);
SETTLED / FEE / NET come from BANK (matched deposit) or MANUAL.

## 9. Phased application plan (each a separate PR, each behind an owner gate)

* **PR-1 (this PR)** — migration only + lab + evidence + this design. Owner merges; owner applies via
  release-migrate; post-apply evidence (`payment-settlement-facts-production-evidence.sql`) 20/20.
* **PR-2 — model + read API (no writes).** `schema.prisma` model (with partial unique indexes declared or
  documented as DB-only), a read service returning per transaction the current fact per kind + history, the
  per-currency aggregation of §6. Flag off. Drift proof in its own lab.
* **PR-3 — CHARGED from the webhook.** Inside the existing settlement transaction, record `CHARGED / PROVIDER`
  (sourceRef = provider transaction id, idempotency key `provider:txn:<id>`); reversals likewise from the refund
  service. Backfill job (owner-run) for existing PAID transactions.
* **PR-4 — MANUAL entry + review UI** on the payment page: enter a MANUAL fact; see NEEDS_REVIEW facts with
  their reason; clear one (a superseding VERIFIED fact with a note). The route checks the permission of §11.2
  (`payments.settlement.record`) before writing, sets `recordedByUserId` = the session user and writes a
  `PaymentAuditEvent` (`SETTLEMENT_FACT_RECORDED` / `SETTLEMENT_REVIEW_CLEARED`) in the same transaction.
  An ingester (PR-5 / PR-6) that meets a disagreement writes the NEEDS_REVIEW set (the disagreeing number + the
  restated others) instead of dropping it.
* **PR-5 — BANK matching** — suggest incoming `ExternalTransaction` (CREDIT) lines for a payment's NET / SETTLED,
  owner confirms (same rules as payables reconciliation: amount alone never establishes identity).
* **PR-6 — PROVIDER settlement data** — only after CardCom's answers (§8): parse fee / net / rate from the API or
  deposit report.
* **PR-7 — Home / collection summaries** per §6.

## 10. Rollback runbook (owner-run)

The reversal is `.sfx/rollback.sql`, run **as the migration role**:

1. Make sure no deployed code reads or writes `PaymentSettlementFact` (PR-2+ not deployed, or reverted and its
   deployment replaced first).
2. Run the preflight-style check: `SELECT count(*) FROM "PaymentSettlementFact"` must be 0. The script refuses
   by itself while any row exists ("payment settlement facts rollback refused: rows exist"); discarding recorded
   facts is a separate owner decision, never a side effect.
3. `psql -X -v ON_ERROR_STOP=1 -f .sfx/rollback.sql` — drops the table (policies, triggers, indexes, sequence,
   grants with it), its three functions, and its ledger row, in one transaction.
4. Run `ops/evidence/payment-settlement-facts-preflight.sql` — it must pass again (the lab proves the schema
   fingerprint is byte-identical to before the migration, and that `prisma migrate deploy` re-applies it whole).

## 11. Owner decisions

Decided by the owner on 2026-10-23 and implemented in this PR (decisions 4–5 stay open):

### 11.1 NET mismatch → record and flag, never lose, never verify

The strict refusal is replaced. A set of current SETTLED / FEE / NET in one currency that does not add up is
**stored**, as `NEEDS_REVIEW` (`reviewReason = NET_MISMATCH`), never as verified:

* the writer that meets the disagreement records the disagreeing number as NEEDS_REVIEW **and restates** the
  other current facts of the set as NEEDS_REVIEW versions (same values and source, `supersedesId` = the VERIFIED
  fact) — in one transaction. Append-only: the original VERIFIED rows stay, so nothing is lost;
* the commit-time check refuses only a **VERIFIED** fact contradicting the others (DZS08); the error says how to
  store the set instead. So data is always storable, and a mismatch is never silently "verified";
* `reviewReason` is a fixed set: `NET_MISMATCH` (the DB's own arithmetic), `CURRENCY_MISMATCH` and
  `SOURCE_CONFLICT` (the writer's judgement, e.g. a currency other than the provider stated, or the provider and
  the bank disagree on one number). A NEEDS_REVIEW fact is always storable, even when the set adds up;
* **clearing** = a new superseding `VERIFIED` fact by a named user of the business with a note (DZS10), and the
  set must then add up (DZS08). Each fact of the set is cleared by its own successor (a clearance of one may
  already make the set consistent — e.g. the fee found to be 3.00 — but the others stay flagged until cleared);
* serialisation is unchanged: the advisory lock + READ COMMITTED; the lab runs a refused VERIFIED race and a
  stored NEEDS_REVIEW race (the second writer waits, then sees the first writer's committed rows).

### 11.2 Who may enter MANUAL facts / clear a review — the DB vs application split

What exists: `User.businessId` (each user belongs to exactly one business; today every business has exactly one
user, its owner — signup creates it and account deletion speaks of "the sole user") and `User.role`
(`USER` / `PLATFORM_ADMIN`), which is **platform** scope, not a business or financial role (the platform admin is
also an ordinary owner of their own business). There is no membership, business-role or permission table, and
`BusinessFeatureAccess` is feature gating, not a user permission. So:

| Rule | Enforced by |
|---|---|
| MANUAL ⇒ `recordedByUserId` NOT NULL | DB — guard DZS06 (at insert) |
| MANUAL ⇒ a non-blank `note` (the data source / evidence) | DB — CHECK `PaymentSettlementFact_manual_note` |
| the recording user belongs to the row's business (also for BYPASSRLS writers) | DB — `task_user_same_business('recordedByUserId')` (DZT03) |
| review clearance ⇒ user + note | DB — guard DZS10 |
| when / what it replaced | DB — `recordedAt` (database clock, writer's value overwritten), `supersedesId` |
| **the user is the business owner or holds the financial permission** | **Application** — the route of PR-4 |

The application check: permission **`payments.settlement.record`**. Until a member / permission model exists it
resolves to "the authenticated session user (`getCurrentUser`) whose `businessId` is the tenant of the request —
i.e. the business owner"; a platform admin's elevated / support access to **another** business never satisfies it
(and the DB refuses that user anyway: another business). When a member model is introduced, only the owner and
members granted `payments.settlement.record` pass. The DB does **not** check `User.role`: it carries no business
meaning and checking it would wrongly refuse the platform admin's own business.

**Erasure stays coherent:** the actor rules are checked when a row is written (BEFORE INSERT), not as a CHECK, so the
FK action that blanks `recordedByUserId` on a user's erasure (the one append-only exception) keeps MANUAL facts
and clearances valid; the row keeps that a person entered it, when, and the note. The lab proves both.

### 11.3 Representative / estimated (≈) amounts

Never stored as facts — there is no source value for them, and no source, kind, verification or review reason can
represent one (the lab proves each). They may be **shown separately, for information only**, never inside
received or net totals; the application PR renders them distinctly (§5 last row) and tests that no total includes
them.

### 11.4 Apply order with `20261025090000_currency_settings_fx_rates`

`20261025090000` first, then this migration — see [MIGRATION-ORDER.md](MIGRATION-ORDER.md). No safety check is
changed for it.

### Still open

1. **Backfill** of CHARGED for existing PAID transactions (PR-3) — yes / no.
2. **Asking CardCom** the questions in §8 (and who asks).
