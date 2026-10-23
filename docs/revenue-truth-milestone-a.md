# Revenue truth: milestone A (foundation)

Status: **prepared, not applied**. Migration `20261028090000_revenue_truth_foundation` and its application code
exist on draft PRs only. Nothing reads or writes the new tables in any deployed environment. Applying the
migration and any consumer each need a separate owner approval.

Source: the POS / Z report / bank audit of 2026-10-23 (owner-approved scope: milestone A only).

## The problem

Today four things each count as "income":

| Store | What it actually is | Who reads it |
|---|---|---|
| `BillingDocument` | the tax view: issued invoices, receipts, credit notes | uniform export, Business Brain income rules, customer card |
| `PaymentTransaction` | money collected through Dubiz | Home ("נגבה דרך Dubiz") |
| `FinancialRecord` | documents the owner uploaded and approved | documents dashboard, accountant export |
| `FinancialEvent` | a ledger that is written but never read | nobody |

`FinancialEvent` already books an invoice and its payment as **two** INCOME rows. POS sales, Z reports, card
settlements and bank deposits all describe money that one of these already counts. Added as more "income",
each of them would count it again.

## The model: four layers, one economic event

Every source is **evidence for one layer** of a sale, never a new income event.

| Layer | Table | Creates revenue? |
|---|---|---|
| 1. Sale | `RevenueSale` (sale / refund / void), `RevenueDailyClose` (Z) + tender / VAT lines; Dubiz `BillingDocument` (read in place) | **yes, the only layer that does** |
| 2. Receipt | `RevenueReceipt`, Z tenders; Dubiz `PaymentTransaction` and receipt documents (read in place) | no |
| 3. Settlement | `RevenueSettlement` (acquirer / provider credit: gross, fee, net, installment) | no; fee = gross − net |
| 4. Deposit | existing `ExternalTransaction` CREDIT lines (reused, not copied, not changed) | **never** |

`RevenueLink` connects layers as a proposal: sale ≡ Dubiz document, tender → settlement, settlement → deposit,
cash → deposit. `RevenueDecision` is the append-only journal of confirm / reject / revoke on a link, or on a Z
report read from a photo. A link's current state is its latest decision. A rejected pair is never proposed
again (unique per pair).

## Authority: which source counts a register day

The read model (`lib/revenue-truth/read-model.ts`, application PR) decides per
`(sale stream, register, business day)`:

| Situation | Counted | The other sources |
|---|---|---|
| An effective Z exists | the Z totals; the day is **closed** | POS sales of that day are excluded (`COVERED_BY_CLOSE`), and the difference is reported as variance |
| No Z, today | POS sales, **provisional** | none |
| No Z, past day | POS sales, **unclosed** | none |
| Dubiz documents | issued tax invoices / invoice-receipts as sales, credit notes as refunds | a document linked (confirmed) to a register sale is excluded (`SAME_AS_SALE`) |
| Bank only | nothing as sales | credits shown as money in, matched or unmatched |

A Z is *effective* when it is the latest revision of its chain, it was not rejected, its validation did not fail,
and, if it was read from a photo or scan (`FILE_EXTRACTED`), the owner confirmed it.

Receipts: a `PaymentTransaction` and the system receipt document issued for it (`sourcePaymentTransactionId`) are
one receipt. A payment never adds to sales, so an invoice plus its payment are one sale and one receipt.

## Money

- Integer minor units (`BIGINT`), never Float. The read model sums `bigint` per currency.
- Currencies limited to the platform set (ILS, USD, EUR). The read model **never** sums across currencies: every
  figure is a per-currency map, and a single-figure request with more than one currency throws
  (`CurrencyMismatchError` from `lib/money`). Conversion is a separate, explicit, future decision.
- The database enforces each layer's arithmetic: sale total = gross − discount; Z total = gross − discount −
  refunds − voids; settlement net = gross − fee − other deductions.

## History

Every revenue table is append-only for every role, the migration owner included. Corrections are new rows: a
refund or void names its original sale; a corrected Z is revision n+1 superseding revision n (a chain, never a
fork); a changed mind is a new decision. Rows leave only with their business (cascade), or with the bank line a
link names.

## Tenancy and privacy

- ENABLE + FORCE RLS; per-command SELECT / INSERT policies on `app.current_business_id`; no UPDATE / DELETE
  policy; the runtime holds SELECT, INSERT only (the owner's default privileges are revoked by name).
- Cross-business references are refused by the database: composite `(businessId, id)` keys between the new tables
  and to `Document` / `AcquisitionConnection`; a guard trigger for `ExternalTransaction` / `BillingDocument`
  (they have no such key, and adding one would change an existing table).
- No free text and no personal data: every text column is a CHECK-limited token. There is no name, description
  or card-number column.

## Coexistence (nothing existing changes)

| Existing | In milestone A |
|---|---|
| `BillingDocument`, issuing | unchanged; read in place by the read model; never written |
| `FinancialRecord`, scanned documents | unchanged; **not** an input (an approved upload is not proof of a sale; see open decisions) |
| `FinancialEvent` | unchanged, keeps writing as today; **not** a source of truth and not read |
| `PaymentTransaction`, payments | unchanged; read in place as receipts |
| `ExternalTransaction`, bank lines | unchanged; read in place as deposits (CREDIT only); links may point to it |
| Payables, daily cost, Home, learning engines | unchanged; no consumer is connected |
| `/api/inventory/pos/sale` | **untouched and outside the new layer** (see the risk below) |

The read model and the writers exist as code with tests only. No route, page, job, sensor or flag uses them.

## Known risk left in place: the legacy POS route

`app/api/inventory/pos/sale` stays as it is (owner instruction). It authenticates with a static key, falls back to
one hard-coded business through env vars, compares the secret non-constant-time, dedupes on
`(businessId, externalSaleId)` without the source, reads the request with no size limit, and is BLOCKED in the
learning coverage because its pending-match path corrupts stock. It moves stock only and writes no revenue. The
new layer neither reads it nor depends on it; it is to be replaced by a managed connection in milestone D.

## Open owner decisions

1. **Scanned income documents (`FinancialRecord`).** Excluded from the revenue read model. Should an approved
   uploaded income document ever count as a sale (for businesses with no other source)?
2. **Retention vs. erasure.** Z reports and settlement files are fiscal records (7 years, bookkeeping instructions
   §25). The tables cascade with the business today, as every tenant table does. Decision ה11 of the audit.
3. **Raw source payloads.** Only a SHA-256 of each source record is kept (`sourcePayloadHash`). Keeping the raw
   payload (or the original file, already possible through `documentId`) is a retention / privacy decision.
4. **Tolerances.** The read model reports Z vs. POS variance exactly; a tolerance for "closed with variance" is
   not set.
5. **Business day.** Callers pass the business day (Israel time). Late-night sales after midnight before the Z
   belong to the Z's day; the adapter rules for that are milestone B / D work.
