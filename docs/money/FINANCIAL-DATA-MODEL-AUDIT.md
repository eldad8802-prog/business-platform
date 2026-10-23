# Financial data model — multi-currency audit

Baseline: `origin/main` @ `f6c261f9` (2026-10-22). Branch `docs/financial-currency-design`.
Method: static reading of `prisma/schema.prisma`, every writer and every aggregation in `app/ lib/ features/ components/ hooks/`
(tests excluded) plus `scripts/` where it reads money. **No database, no Production, no `.env` was read** — every statement
about "what rows exist" is **code-derived** (what the code can write), not a count of real rows.

Companion documents: [MULTI-CURRENCY-FINANCIAL-DESIGN.md](./MULTI-CURRENCY-FINANCIAL-DESIGN.md) ·
[proposed-financial-currency-migration.sql](./proposed-financial-currency-migration.sql) ·
guard `scripts/ci/cross-currency-sum-guard.mjs` + its reviewed baseline `scripts/ci/cross-currency-sum-guard.baseline.json`.
Earlier audit this builds on: [../i18n-multicurrency/ARCHITECTURE.md](../i18n-multicurrency/ARCHITECTURE.md) (R1–R10).

Risk scale used everywhere below:

| risk | meaning |
|---|---|
| **SAFE** | single-currency by construction **and** enforced (one document / one installment / one settlement with a currency assertion on write, or an explicit currency filter / group) |
| **LATENT** | correct only because every row it reads is ILS today (no currency column, or every writer of the rows it reads hard-codes ILS) |
| **BROKEN** | a code path exists **today** that writes a non-ILS row into the set being added, so it can add ILS + USD now |

"BROKEN" is a statement about code, not about data: all payment-provider connections are `NOT_CONFIGURED` in Production by
design (payments-core-safety, 2026-10-08), so the payment-side BROKEN items have **no known Production exposure yet**; the
obligation/payables items do not depend on a provider.

---

## 0. Headline findings (BROKEN first)

| # | finding | where | risk |
|---|---|---|---|
| **B1** | **A foreign-currency RECEIPT can be issued automatically today.** The settlement of a verified payment issues a receipt in the *payment's* currency. A standalone payment request (no invoice) accepts `currency` from the API, CardCom/Tranzila accept USD/EUR and PayPal passes it through, so a USD payment settles into an **issued USD RECEIPT** — a tax-relevant document that then enters the uniform file and the §2.6 report, whose totals add it to ILS. "Foreign-currency tax documents are blocked" holds for invoices only (`billing-draft.service.ts:218` hard-codes ILS), **not** for receipts. Not designed here (settlement is out of scope) — **flagged for an owner decision** (see design §9 D1). | `lib/services/billing/settlement/payment-accounting-settlement.service.ts:337,472` → `lib/services/billing/receipt/billing-receipt-draft.service.ts:154`; request side `lib/services/payments/payment-request.service.ts:95,240,323` | **BROKEN** (writer) |
| **B2** | **Home income figures add every currency.** Month / previous month / day / hour buckets / "same point last period" `_sum` and folds over `PaymentTransaction.amount` with no currency filter, rendered as ₪. | `lib/services/home/home-day.service.ts:151,156,220,221`; `lib/services/home/home-collection.service.ts:143,201,206,230` | **BROKEN** |
| **B3** | **Collection workspace totals add every currency** (pending / expired / collected this month). | `lib/services/payments/collection-workspace.service.ts:116,121`; `lib/services/payments/payment-store.prisma.ts:757` (`sumPaidBetween`) | **BROKEN** |
| **B4** | **Secretary obligation totals add every currency and label the result with the first row's currency.** `BusinessObligation.currency` accepts any ISO code via `/api/obligations`. | `app/(shell)/secretary/page.tsx:550,668`; `app/(shell)/secretary/secretary-ui.tsx:738-739` | **BROKEN** |
| **B5** | **R7 — receipt payment lines are summed without checking their currency against the receipt** (each line accepts any 3-letter code). An ILS receipt can be issued from a USD line; the issuable-shape check compares the mixed sum with the total. | `lib/services/billing/receipt/billing-receipt-allocation.rules.ts:132`; `lib/services/billing/billing-issuable-shape.rules.ts:59`; validation `lib/services/billing/validation/billing-payment.validation.ts:134` | **BROKEN** |
| **B6** | **Uniform export / §2.6 report totals add all issued documents** (incl. B1 receipts) with no currency. | `lib/services/billing/uniform/uniform-export-assembler.ts:261-262`; `lib/services/billing/uniform/uniform-report-data.ts:104,114` | **BROKEN** (via B1) |
| **B7** | **Bank line → payment relabels currency.** `recordPaymentFromObservation` records the bank line's amount as a Payment in the *commitment's* currency; the line's currency (always the `ILS` default — `ExternalTransaction` is created without a currency) is never compared with the commitment's (which accepts any ISO code). 1,000 ILS on the statement becomes a 1,000 USD payment. | `lib/services/payables/payables-observation.service.ts:590-640` → `lib/services/payables/payables.service.ts:784`; `payables-observation.service.ts:95` (no currency on insert) | **BROKEN** (writer) |
| **B8** | **Payables matching compares a FinancialRecord amount (no currency) with a USD/EUR payment or installment.** Suggestion only — the owner confirms — but the "amount agrees" signal is cross-currency. | `lib/services/payables/payables-matching.ts:45,164,196`; `lib/services/payables/payables-reconciliation.service.ts:154,448` | **BROKEN** (comparison, low) |
| L1 | **`FinancialRecord` has no currency** (`amount Float`) and feeds the documents inbox, reports summary/CSV, accountant ZIP (incl. Excel SUM formulas), DOC-05 learning and payables matching. | §1, §2 | LATENT |

Counts (aggregation sites, §2): **guard-detected 55** — SAFE 28 · LATENT 12 · BROKEN 15; **manually found, outside what a text guard
can see 24** — SAFE 11 · LATENT 8 · BROKEN 5. Total **79 sites: SAFE 39 · LATENT 20 · BROKEN 20.** Writer findings (B1, B5, B7) are
counted separately in §1.

---

## 1. Every money-bearing model

Columns and types are from `prisma/schema.prisma` (line = model start). "Writers" are the production code paths found with
`<model>.(create|createMany|upsert|update|updateMany)(` (tests, fixtures and `.m0/ .p7w4d/ .authfix/` lab batteries excluded).
"Non-ILS possible today" = can any current code path store a non-ILS value (or a foreign amount in a currency-less row).

### 1a. Models WITH a currency column

| model (line) | amount columns | currency column | currency known at write? | writers (file:line) | non-ILS possible today? |
|---|---|---|---|---|---|
| `BillingDocument` (2625) | `subtotalAmount, vatAmount, totalAmount, unappliedAmount` Decimal(18,2) | `currency String @default("ILS")` | yes | drafts `lib/services/billing/billing-draft.service.ts:213` (**hard-codes `"ILS"` at :218**, R2); quote→invoice `convert-quote-to-invoice.service.ts:116` (copies quote); credit note `billing-credit-reversal.service.ts:228` (copies + enforces source, :165); receipt `receipt/billing-receipt-draft.service.ts:200` (**`input.currency`**, :154); updates `domain/billing-document-mutation.gateway.ts:106`, `authority/billing-authority-transition.service.ts:763` | **YES — RECEIPT via settlement (B1).** QUOTE / TAX_INVOICE / TAX_INVOICE_RECEIPT / CREDIT_NOTE: no. Issued rows are frozen by `secf_fiscal_immutable` (migration `20260926140000_…`) |
| `BillingDocumentLine` (2721) | `unitPrice` Decimal(18,4), `lineSubtotal, vatAmount, lineTotal` Decimal(18,2) | none (header currency) | n/a | `billing-draft.service.ts:152`, `convert-quote-to-invoice.service.ts:132`, `billing-credit-reversal.service.ts:245`, `billing-receipt-draft.service.ts:223` | follows the header (child-immutable trigger) |
| `BillingReceiptPayment` (2752) | `amount` Decimal(18,2) | `currency @default("ILS")` | yes, **any ISO code, unchecked vs header** | `billing-receipt-draft.service.ts:238,309` | **YES (B5 / R7)** |
| `BillingPaymentAllocation` (2776) | `allocatedAmount` Decimal(18,2) | `currency @default("ILS")` | yes = receipt currency, `assertSameCurrency` with invoice | `receipt/billing-payment-allocation.service.ts:200` (:177) | only if receipt and invoice share it (enforced) |
| `FinancialEvent` (2793) | `amount` Decimal(18,2) | `currency @default("ILS")` | yes (document currency) | `lib/services/financial-events/financial-event.service.ts:55` (doc.currency), `:146` (input) | follows documents → yes for B1 receipts |
| `PaymentRequest` (3765) | `amount` Decimal(18,2) | `currency @default("ILS")` | yes, `normalizeCurrency` = any `^[A-Z]{3}$`, then provider allow-list | `lib/services/payments/payment-store.prisma.ts:412` (from `payment-request.service.ts:240`); status updates `:433,464`, `billing/settlement/settlement-resolution.service.ts:63` | **YES** (standalone requests; with an invoice the currency must match it) |
| `PaymentTransaction` (3794) | `amount` Decimal(18,2) (refund reversals = negative PAID rows) | `currency @default("ILS")` | yes, the provider-verified currency | `payment-store.prisma.ts:788,849` | **YES** (verification flags `PAYMENT_VERIFIED_CURRENCY_MISMATCH`, settlement `VERIFIED_CURRENCY_MISMATCH`) |
| `HistoricalFiscalDocument` (4428) | `subtotalAmount, vatAmount, totalAmount` Decimal(18,2)? | `currency String?` | yes — import **refuses** anything but ILS (`historical-analyze.ts:565-573`, "כרגע נקלטים שקלים בלבד") | `lib/data-transfer/historical/historical-execute.ts:500` | no |
| `BusinessObligation` (1577) | `amount` Decimal(18,2) | `currency @default("ILS")` | yes, any ISO code (`obligation-core.ts:41`) | `lib/services/obligations/obligation-store.prisma.ts:80,105` (from `app/api/obligations/route.ts:82`, `[id]/route.ts:57`) | **YES** |
| `Commitment` (5167) | `totalAmount` Decimal(18,2)? | `currency @default("ILS")` | yes, any ISO code (`payables.service.ts:281`) | `lib/services/payables/payables.service.ts:347,548,1292`; `obligation-store.ledger.ts:220,315`; `secretary-ledger-cutover.service.ts:388,445,449` | **YES** (`app/api/payables/commitments/route.ts:95`) |
| `Installment` (5208) | `scheduledAmount` Decimal(18,2) | `currency @default("ILS")` | yes = commitment currency | `payables.service.ts:365,1009,1078,1195,1281,1326`; `obligation-store.ledger.ts:276`; cutover `:404` | follows commitment |
| `Payment` (5271) | `amount` Decimal(18,2) | `currency @default("ILS")` | yes = commitment currency | `payables.service.ts:778,920` (:784); `payables-cheque.service.ts:577,655`; `payables-preparation.service.ts:614` | follows commitment — **but see B7** |
| `PaymentAllocation` (5320) | `allocatedAmount` Decimal(18,2) | `currency @default("ILS")` | yes; `planAllocation` throws on mismatch (`payables-core.ts:537`) | `payables.service.ts:821,957` | enforced |
| `Cheque` (5511) | `amount` | `currency @default("ILS")` | yes | `payables-cheque.service.ts:413,476,531,676,706,761` | follows commitment |
| `PaymentPreparation` (5620) | `amount` | `currency @default("ILS")` | yes | `payables-preparation.service.ts:430,485,528,643`; `payables-outbound.service.ts:227,319` | follows installment |
| `ExternalTransaction` (5669) | `amount` | `currency @default("ILS")` | **no** — inserted without currency (`payables-observation.service.ts:95`) | same | stored ILS even for a foreign account (latent mislabel; B7) |
| `OutboundExecution` (5726) | `amount` | `currency @default("ILS")` | yes | `payables-outbound.service.ts:212,277,309,366,381` | follows preparation |
| `Lead` (840) | `valueEstimate, finalPrice` Decimal(18,2)?, `quotedPrice` Float? | `currency String? @default("ILS")` + DB CHECK ISO (`20261002090000_crm_lead_lifecycle`) | yes | `lib/services/crm/lead.service.ts:453,879,999,1132` (amount + currency :1222-1247); `lead-lifecycle.service.ts:165` | yes (any ISO), not aggregated anywhere |
| `Deal` (949) | `quotedPrice, finalPrice, estimatedCost, actualCost, discountAmount, grossProfitAmount` Float? | `currency String? @default("ILS")` | n/a | no production writer found | legacy, no writer |
| `CommerceOrder` (6857) | `totalMinor, refundedMinor` Int (minor units) | `currency String` (CHECK ISO, `20261013090000_m7a_…`) | yes (Wix/Woo payload) | `lib/intake/routing/commerce-destination.ts:197,226,243` | yes; shown per order on the customer card only (`customer-card.read-model.ts:238`), never summed |

### 1b. Models with money and NO currency column

| model (line) | amount columns | writers | what currency the value is in | non-ILS possible today? |
|---|---|---|---|---|
| **`FinancialRecord` (1856)** | `amount Float` (double precision) | **only** `app/api/documents/[id]/approve/route.ts:277` (upsert inside the approval tenant tx). Also lab batteries / `payables-2.db.test.ts:95` (test only). | whatever the reviewer approved: OCR-extracted or typed; no currency field in the review UI; OCR recognises only ₪/ש"ח/NIS/ILS (`document-guardrail.service.ts:34`) | **a foreign receipt's number can be stored as a bare number** (R10). No path writes a currency. |
| `ExtractedData` (1841), `ExtractionSnapshot` (1906) | `amount Float?` | `create-document-from-ocr.service.ts:186`, `process-document-pipeline.service.ts:162`, approve route `:255`; `ledger/correction-ledger.service.ts:267` | OCR belief | same as above |
| `LeadLifecycleEvent` (6711) | `amount Decimal(18,2)?` | `lead-lifecycle.service.ts:182` | the lead's currency at that moment (not stored on the event) | yes, unlabelled history |
| `BusinessService` (796) | `basePrice Float?`, `priceAmount, priceMax` Decimal(18,2)? | `lib/services/offering/business-service.service.ts:69` | business currency assumed | LATENT |
| `Offer` (999) | `minPurchaseAmount` Decimal(18,2)? | `lib/services/offer.service.ts:46`; `revenue/publish-coupon.service.ts:148`, `my-coupons.service.ts:200,216,285` | assumed ILS | LATENT |
| `PricingProfile` (1373), `PricingCalculation` (1393), `PricingRecommendation` (1360), `ServiceCostProfile` (1347) | Float costs / prices | `app/api/pricing/profiles/route.ts:128`, `[id]/route.ts:195,253`, `app/api/pricing/calculate/route.ts:175` (others: no writer found) | assumed ILS | LATENT |
| `InventoryItem` (2075) | `costPerUnit, lastPurchaseCost, sellPricePerUnit` Float? | `lib/services/inventory/inventory.service.ts:67,171`, `pending-match.service.ts:393`, `receiving.service.ts:460`, `app/api/inventory/items/[id]/route.ts:311` | assumed ILS | LATENT |
| `InventorySaleLine` (2246), `InventorySourceSaleLine` (2272) | `unitPrice` Decimal(18,2)? | `sale-evidence.service.ts:187`, `sale-source-lines.service.ts:30,61` | assumed ILS | LATENT |
| `SupplierPurchaseDraftLine` (2444), `PurchaseOrderLine` (2554), `ReceivingLine` (2607) | `unitCost Float?` | `supplier-purchase-approval.service.ts:264`, `supplier-purchase-intake.service.ts:244`, `purchase-order.service.ts:561` | assumed ILS (supplier invoices in foreign currency are possible in reality) | LATENT |
| `CommerceOrderLine` (6895) | `unitMinor, totalMinor` Int | `commerce-destination.ts:101,107` | the order's currency | follows order |
| `CollaborationDeal` (975) | `estimatedValue Int` | `lib/collaboration/matchingEngine.ts:160`, `app/api/deals/[id]/route.ts:59` | assumed ILS | LATENT |
| `RecommendationOutcome` (1270) | `businessImpactValue Float?` | no writer found | — | — |
| `KnowledgeMeasure` (5912) | `valueNumeric Decimal(18,4)` with `valueUnit = "currency"` (no ISO code) | `lib/knowledge/measure-writer.ts:107`, `measure-reconciler.ts:79,103` | the currency of its evidence (CUST-03 = BillingDocument, DOC-05 = FinancialRecord) | LATENT (R9) |

**Not present in the schema** (searched `^model .*(Subscription|Plan|Invoice|Refund|Settlement|Expense|Payable)`): no platform
subscription / platform billing model (only `PushSubscription`), no separate refund table (refunds = negative `PaymentTransaction`
rows + `CREDIT_NOTE` documents), no separate settlement-amount table (`PaymentAccountingSettlement` has no amount), no supplier
invoice table (supplier invoices arrive as `Document` → `FinancialRecord`, or as payables `Commitment`). Every migration-only
`CREATE TABLE` without a Prisma model was checked (`POSConnection`, `POSSaleEvent`, `SecurityEvent`, `TaskRetentionPolicy`,
`PushSubscription`): none carries money.

### 1c. Where FinancialRecord rows come from, and are they all ILS?

- **One writer**: the document approval route (`app/api/documents/[id]/approve/route.ts:277`), inside `runTenantJob` +
  `withTenantTransaction`, after the approved-mutation guard (`:186-218`). Inputs: `merged.amount` (OCR extraction merged with the
  reviewer's edits, `:100-150`), vendor, category, direction, date. **No currency is captured anywhere on this path** — not in
  `ExtractedData`, not in the review UI (`app/(shell)/documents/**` and `components/documents/**` format with a fixed `"ILS"`:
  `documents/dashboard/page.tsx:130`, `components/documents/home/home-format.ts:18`).
- No import, backfill, historical import (`HistoricalFiscalDocument` is a separate table), webhook, or cron writes FinancialRecord.
- **Code-derived conclusion:** every existing row is *treated* as ILS by every consumer and was entered through a UI that shows only
  ₪, but **nothing proves the number was ILS** — a photographed USD/EUR receipt can be approved with its foreign number (R10). The
  backfill therefore sets `currency = 'ILS'` **with a provenance marker `currencySource = 'BACKFILL_ASSUMED'`**, and the proof set
  (design §7) includes a read-only query that lists approved documents whose OCR text carries `$ / € / USD / EUR` so the owner can
  review the few suspects before the base amounts are trusted.

---

## 2. Every aggregation of money

### 2a. Search patterns (systematic, over `app lib features components hooks`, then `scripts`; tests/fixtures excluded)

| # | pattern (ripgrep / node) | purpose | non-test hits |
|---|---|---|---|
| P1 | `_sum` | Prisma aggregate/groupBy sums | 43 lines → 13 calls on money |
| P2 | `\.aggregate\(` | Prisma aggregates (incl. `_max`/`_count`) | 17 |
| P3 | `\.groupBy\(` | Prisma group-bys | 20 (all others count-only) |
| P4 | `SUM\(` / `\bsum\s*\(` / `\bavg\s*\(` / `percentile_cont` (case-insensitive) | raw SQL / spreadsheet sums | 1 runtime (Excel formula) + 2 QA scripts |
| P5 | `\.reduce\(` ∧ `amount\|total\|price\|cost\|minor\|vat\|paid\|balance\|money` | JS folds | 90 lines, ~45 money |
| P6 | `\+=` / `= x\.plus\(` / `\.add\(` ∧ money names | JS accumulation | ~25 money |
| P7 | `(\?\?\|\|\|) ?0\) ?\+ …amount` | `map[k] = (map[k] \|\| 0) + amount` | 1 |
| P8 | `\.plus\(` (all) | Decimal accumulation | 31 |
| P9 | `Minor ?\+\|\+ ?…Minor\|Number\(…amount\) ?\+` | minor-unit arithmetic | 10 |
| P10 | `\[0\]\??\.currency` | "first row's currency" labelling (R5) | 4 |
| P11 | `currency` (`!==`, `===`, `assertSameCurrency`, `CURRENCY_MISMATCH`, `baseCurrency`) | where currency IS enforced | ~60 |
| P12 | `sumDecimal2\|sumPaymentLineAmounts\|sumAllocationAmounts\|sumPaidBetween` | named sum helpers | 6 |
| P13 | `<model>\.(create\|createMany\|upsert\|update\|updateMany)\(` for each money model | writers (§1) | 158 lines |

The guard (`scripts/ci/cross-currency-sum-guard.mjs`) mechanises P1–P4, P5/P6 restricted to the schema's guarded money columns, and
P10. Its 55 findings are in the baseline JSON with risk + reason; they are summarised in 2b. 2c lists what a text guard cannot see.

### 2b. Guard-detected sites (55) — summary by group

| group | sites (file:line) | columns | grouped by currency? | risk |
|---|---|---|---|---|
| Home income (B2) | `lib/services/home/home-day.service.ts:151,156` (`_sum`), `:220,221` (buckets / total); `lib/services/home/home-collection.service.ts:201,206` (`_sum`), `:143` (buckets), `:230` (same-point fold) | `PaymentTransaction.amount` | no | **BROKEN** ×8 |
| Collection workspace (B3) | `lib/services/payments/collection-workspace.service.ts:116,121`; `lib/services/payments/payment-store.prisma.ts:757` | `PaymentRequest.amount` | no | **BROKEN** ×3 |
| Secretary (B4) | `app/(shell)/secretary/page.tsx:550` (first-row currency), `:668` (fold); `app/(shell)/secretary/secretary-ui.tsx:738` (first-row currency) | `BusinessObligation.amount` | no | **BROKEN** ×3 |
| Receipt lines (B5 / R7) | `lib/services/billing/receipt/billing-receipt-allocation.rules.ts:132` (`sumPaymentLineAmounts`) | `BillingReceiptPayment.amount` | no | **BROKEN** ×1 |
| Documents inbox (R6) | `app/api/documents/inbox/route.ts:236,244,290,298,380,388` | `FinancialRecord.amount` | no column | LATENT ×6 |
| Reports summary (R6) | `app/api/reports/summary/route.ts:49,50` (also `:52` category map) | `FinancialRecord.amount` (Float) | no column | LATENT ×2 |
| Accountant ZIP | `lib/reports/accountant-export-zip.ts:305,309` | `FinancialRecord.amount` | no column | LATENT ×2 |
| Inventory sale | `app/(shell)/inventory/sales/create/page.tsx:77` (name collision, unit price) | — | no column | LATENT ×1 |
| Test double | `lib/services/payments/payment-store.memory.ts:349` (mirror of `sumPaidBetween`) | `PaymentRequest.amount` | no | LATENT ×1 (not Production) |
| One invoice: allocations / credit notes | `billing/domain/billing-invoice-economic-remaining.ts:63,74`; `billing/receipt/billing-settlement-state.service.ts:85`; `billing/billing-credit-reversal.service.ts:73`; `billing/collection/awaiting-payment.loader.ts:133`; `billing/collection/customer-financial-thread.service.ts:123`; `knowledge/snapshot/snapshot-sources.ts:344`; `payments/payment-store.prisma.ts:596,600` | `BillingPaymentAllocation.allocatedAmount`, `BillingDocument.totalAmount` | single document; `assertSameCurrency` / credit currency = source | SAFE ×9 |
| One receipt | `billing/receipt/billing-receipt-allocation.rules.ts:141`; `billing/collection/collection-inbox.service.ts:352` | `allocatedAmount` | single receipt, asserted | SAFE ×2 |
| One document's lines | `billing/totals/billing-totals.service.ts:45` | line `vatAmount` | header currency | SAFE ×1 |
| Bucketed per currency | `billing/collection/awaiting-payment.rules.ts:240,250` (×2 on :250) | — | yes (bucket key `customer\|currency`) | SAFE ×3 |
| One request / settlement reversals | `billing/collection/collection-inbox.service.ts:314`; `payments/payment-refund.service.ts:229,421` | `PaymentTransaction.amount` | refunds inherit settlement currency | SAFE ×3 |
| Against one document | `payments/payment-request.service.ts:306` | `PaymentRequest.amount` | doc currency enforced | SAFE ×1 |
| One installment / payment (payables) | `business-status/loaders.ts:648`; `knowledge/outcomes/evidence.ts:109`; `knowledge/snapshot/cross-domain.ts:124`; `payables/payables-cheque.service.ts:186`; `payables/payables-preparation.service.ts:229`; `payables/payables-reconciliation.service.ts:254`; `payables/secretary-ledger-cutover.service.ts:181` | `PaymentAllocation.allocatedAmount`, `PaymentPreparation.amount` | `planAllocation` throws on mismatch | SAFE ×7 |
| Business cost | `business-cost/business-cost-intelligence.ts:88,89` | `totalMinor` | base currency by construction (`NON_BASE_CURRENCY`) | SAFE ×2 |

### 2c. Sites a text guard cannot see (manual, 24)

| # | site (file:line) | what | risk |
|---|---|---|---|
| M1 | `lib/services/billing/uniform/uniform-export-assembler.ts:261-262` | `sumTotal` / `sumVat` over every included document via `sumDecimal2` (values mapped to strings first) | **BROKEN** (B1 receipts) |
| M2 | `lib/services/billing/uniform/uniform-report-data.ts:104,114` | §2.6 report per-type and grand totals | **BROKEN** (B1) |
| M3 | `lib/services/billing/billing-issuable-shape.rules.ts:59` | receipt payment-lines total vs document total | **BROKEN** (B5) |
| M4 | `lib/services/payables/payables-matching.ts:164,196` (+ `payables-reconciliation.service.ts:154,448`) | "amount agrees" FinancialRecord (no currency) vs Payment/Installment (USD possible) | **BROKEN** (comparison; B8) |
| M5 | `scripts/qa/home-day-real-data.mjs:39,64` | QA SQL `sum(t.amount)` over PaymentTransaction | **BROKEN** (QA tool only, same defect as B2) |
| M6 | `lib/knowledge/rules/income.ts:226-229` (CUST-03) | median invoice total per customer → `KnowledgeMeasure` "currency" | LATENT (TAX_INVOICE* are ILS-only today) |
| M7 | `lib/knowledge/rules/documents.ts:160-185` (DOC-05) | vendor amount median over FinancialRecord | LATENT (R9) |
| M8 | `app/(shell)/documents/dashboard/page.tsx:252` | categories total (from `/api/reports/summary`) | LATENT |
| M9 | `lib/reports/accountant-export-zip.ts:324,340` | Excel `SUMIF` / `SUM` formulas in the accountant workbook | LATENT |
| M10 | `lib/reports/financial-records-csv.ts` / `app/api/reports/export/route.ts:49` | CSV export, amount without a currency column | LATENT (export) |
| M11 | `lib/data-transfer/documents/documents-export.ts:352` | documents export, amount without currency | LATENT (export) |
| M12 | `app/opportunities/page.tsx:521` | `CollaborationDeal.estimatedValue` total | LATENT |
| M13 | `app/(shell)/inventory/supplier-purchases/page.tsx:143`; `new/cart/page.tsx:34`; `new/confirm/page.tsx:35` | purchase totals `qty × unitCost` | LATENT |
| M14 | `features/home/v3/home-v3-model.ts:203` | week expense total = business-cost cash out (base currency) | SAFE (but drawn beside B2 income) |
| M15 | `lib/services/billing/collection/collection-inbox.service.ts:381-393` | headline: ONE currency (ILS first) + `isMixedCurrency` | SAFE |
| M16 | `lib/services/billing/collection/awaiting-payment.rules.ts:229` | per (customer, currency) bucket | SAFE |
| M17 | `lib/services/billing/collection/customer-financial-thread.service.ts:122,125` | per-currency `outstandingBy` Map | SAFE |
| M18 | `lib/knowledge/snapshot/snapshot-sources.ts:343,350-352` | receivables window: first currency only, others skipped | SAFE (never adds; silently partial — noted) |
| M19 | `lib/knowledge/snapshot/cross-domain.ts:128-130`; `cross-domain-brain.ts:115-121` | payables exposure: first currency only | SAFE (same note) |
| M20 | `lib/knowledge/rules/cost.ts:348-412,768,791` | cost rules filter `currency === baseCurrency` | SAFE |
| M21 | `lib/services/business-cost/business-cost-core.ts:783-846` | daily cost: non-base listed in `otherCurrency`, never added | SAFE |
| M22 | `lib/services/billing/receipt/billing-receipt-allocation.rules.ts:122`; `receipt/billing-payment-allocation.service.ts:148` | allocations + unapplied = one receipt's total | SAFE |
| M23 | `lib/data-transfer/historical/historical-analyze.ts:249` | subtotal + VAT of one imported row (ILS-only import) | SAFE |
| M24 | `lib/knowledge/rules/income.ts:121` (`resolveSettlement`) | coverage of one invoice in agorot | SAFE |

Count- or quantity-only aggregations checked and excluded (no money): `app/api/billing/documents/route.ts:228`,
`platform-admin/platform-business-detail.service.ts:234,255`, `platform-admin/platform-overview.service.ts:69`,
`knowledge/snapshot/snapshot-sources.ts:281-307`, `data-transfer/historical/historical-records.ts:352`,
`inventory/inventory-velocity.service.ts:52`, `inventory/purchase-order.service.ts:201`, `inventory/receiving.service.ts:155`,
`home/home-history.service.ts:58-90` (EXISTS only).

### 2d. Interactions flagged, NOT designed here (owner/accountant scope)

- **R1** `lib/services/billing/authority/billing-authority-readiness.ts:49-50` — ITA allocation threshold applies only when
  `currency === "ILS"`. Harmless while invoices are ILS-only; must become "ILS-equivalent at the representative rate" before any
  foreign invoice exists.
- **R3** uniform file: `uniform/uniform-config.ts:63` (field 1032 fixed ILS), `uniform-file-builder.ts:165-267` (1422/1423 empty).
  B1 receipts already reach it.
- **R4** ITA approval payload `authority/billing-authority-approval-payload.ts:180-345` (incl. the per-document sum at `:331`) —
  no currency / ILS equivalent.
- Settlement / provider behaviour (B1 is a settlement outcome) — design §9 D1 asks the owner; no change proposed to providers.

---

## 3. Precision notes (not currency, but they meet the same code)

- `FinancialRecord.amount`, all inventory / pricing / `Deal` money are `Float` (double). Sums over them are float sums
  (`app/api/reports/summary/route.ts:49-52`, `accountant-export-zip.ts:305-311`). The backfill proof (design §7) checks that every
  amount is representable at 2 decimals before a `numeric(18,2)` base amount is written from it.
- 7 duplicated minor-unit helpers exist (ARCHITECTURE §1.2); `lib/money` is the exact replacement.

## 4. Limits of this audit

- Static only. Runtime paths assembled dynamically (e.g. a column chosen by a variable) are invisible.
- "Non-ILS possible today" means a code path exists; whether any such row exists in Production is **unknown** (no DB access).
- Client components that sum API values (`features/**`, `components/**`) were searched by the same patterns; values renamed on the
  way (`amountMinor`, `outstanding`, `remaining`) are only caught where read manually (2c).
- `scripts/` one-off ops / evidence scripts were searched for SQL sums only; they are not runtime and are not guarded.
- The guard's own limits are listed in its header and in design §8.
