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
cash → deposit. `RevenueDecision` is the append-only journal of confirm / reject / revoke on a link, a Z
report read from a photo, or a sale / receipt / settlement recorded in error (rejected, never edited). A link's current state is its latest decision. A rejected pair is never proposed
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


## History and corrections

Every revenue table is append-only for every role, the migration owner included. Corrections are new rows, never
edits:

- a refund or void is a new sale row naming its original sale;
- a corrected Z is revision n+1 superseding revision n (a chain, never a fork);
- a changed mind on a link or a Z is a new decision;
- **evidence recorded in error** (a sale, a receipt or a settlement, for example a settlement file uploaded twice
  under different ids, or one that belongs to another merchant number) is **REJECTED** by a decision. The row is
  kept exactly as recorded; the read model excludes it from every total and every match (`REJECTED`). A
  rejection can be withdrawn (`REVOKED`). Evidence is never `CONFIRMED`: it is valid as recorded until rejected.

A rejection may not leave the books inconsistent, so the writer (`lib/revenue-truth/store.ts`) refuses it while:

- a **confirmed** link still names the object (revoke the link first): no match may stand on excluded money;
- for a sale, a live (non-rejected) refund / void names it, or a live receipt names it: no refund of, or payment
  for, a sale that no longer counts.

And it refuses to **confirm** a link that names a rejected object. Both rules run under the same per-object
advisory lock, so a rejection and a confirmation racing on one object serialise; exactly one of them wins. The
read model applies the same rules defensively (a link naming rejected evidence closes nothing, and is reported).

## Retention and deletion

- The eight tables are **fiscal records** (erasure registry: `RETAINED_BY_DESIGN`, basis `LEGAL/FISCAL`), like
  `BillingDocument`, `PaymentTransaction` and `FinancialEvent`. The amounts are financial data about the business
  and, for a sole proprietor, about a person; no column identifies a customer.
- **Account deletion is a soft delete**: `Business.deletedAt` is set (`lib/tenant/business-lifecycle.ts`), the
  `Business` row stays, and nothing in the account-erasure code deletes `Business` or `Document` rows. The revenue
  rows therefore stay with the business, untouched by erasure, as the other fiscal records do.
- The only physical delete the append-only trigger lets through is a foreign-key cascade (a hard-deleted
  `Business`, or a bank line a link names). No product path performs either.
- There is **no** automatic deletion and **no** blanket "delete after seven years". A controlled purge after the
  legal retention period is designed below and is **not built**.

### Proposed post-retention purge (design only — needs its own owner approval)

Built like the Daily Tasks retention path (migration `20261018090000`), and OFF until the owner sets a period:

1. `RevenueRetentionPolicy` (not tenant data, FORCE RLS, no policy, no grant): one row per record family with
   `years` **NULL** — no period is assumed.
2. `revenue_retention_purge_business()`, SECURITY DEFINER, owned by the migration role, EXECUTE only for a new
   NOLOGIN role `revenue_maintenance` (no login exists until a separate decision). It:
   - refuses while the period is NULL, and refuses unless the business in the tenant context is PURGED;
   - takes no date from the caller; computes the cut-off from the policy and the **tax year** of each record
     (bookkeeping instructions §25(ג): 7 years from the end of the tax year, or 6 years from filing — whichever is
     later — so the filing date per business is an input it must have, from the accountant);
   - deletes only **whole chains** (a sale with its receipts, links and decisions; a Z with its lines and
     decisions; a settlement with its links and decisions), never a part that would leave a dangling link;
   - honours a legal hold flag (to be designed with counsel).
3. The append-only trigger lets a delete through only when it runs AS the table owner AND inside that function
   (a transaction-local marker), exactly as `task_event_append_only_guard` does.
4. Nothing is scheduled. The first period can expire no earlier than seven years after the first real record.

This is a schema change (a table, a function, a role, a trigger change), so it is presented, not implemented.

## Tenancy and privacy

- ENABLE + FORCE RLS; per-command SELECT / INSERT policies on `app.current_business_id`; no UPDATE / DELETE
  policy; the runtime holds SELECT, INSERT only (the owner's default privileges are revoked by name).
- Cross-business references are refused by the database: composite `(businessId, id)` keys between the new tables
  (decisions included) and to `Document` / `AcquisitionConnection`; a guard trigger for `ExternalTransaction` /
  `BillingDocument` (they have no such key, and adding one would change an existing table).
- No free text: every text column is a CHECK-limited token. There is no name, description or card-number column.
  The data is still personal for a sole proprietor, and is classified as fiscal (above).

## Bank data: file upload only (owner decision, 2026-10-24)

Bank transactions enter Dubiz **only by an uploaded file** (milestone B extends the existing upload into
`ExternalTransaction`). There is no automatic bank connection — no open-banking provider, no aggregator, no use of
a customer's bank credentials — in this milestone, in the plan, or as a future dependency. Real-time API
connections are for **registers (POS) only**. The read model treats `ExternalTransaction` CREDIT lines as deposits
whatever their source; the pre-existing `BANK_FEED` source value (payables, 2026-09) has no writer and none is
planned.

## Coexistence (nothing existing changes)

| Existing | In milestone A |
|---|---|
| `BillingDocument`, issuing | unchanged; read in place by the read model; never written |
| `FinancialRecord`, scanned documents | unchanged; **not** an input (an approved upload is not proof of a sale; specification below; not connected) |
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


## Scanned income documents: specification (not connected)

Direction (owner, 2026-10-24): a verified scanned income document may in future be a source of revenue for a
business that has **no other sale source**, and must never double count against Dubiz invoices, register sales or
Z reports. Milestone A does **not** connect `FinancialRecord` to the read model and changes no existing behaviour.
This section is the specification for the step that would.

### What exists today (facts)

- An approved upload creates one `FinancialRecord` per `Document` (`app/api/documents/[id]/approve/route.ts`):
  `amount` is a **Float**, there is **no currency, no VAT, no document number, no issuer**, and `direction` is a free
  string (`"income"` / `"expense"`) chosen at review.
- `Document` keeps the file, its `contentHashSha256` (deliberately **not** unique: a duplicate is surfaced and can be
  approved anyway) and the OCR text. The extraction engine classifies `invoice | receipt | donation_receipt |
  bank_transfer | quote | non_financial`, but the class is not stored on `FinancialRecord`.

### Authority rules

| # | Rule | Default |
|---|---|---|
| S1 | Only a document **issued by this business** can be income. A document issued TO the business is an expense, whatever `direction` says. | not income unless the issuer is the business |
| S2 | Only a **tax invoice / invoice-receipt** is a sale. A receipt is the receipt layer (money in), never a sale. A credit note is a refund. A quote, a delivery note or a bank-transfer confirmation is nothing. | excluded unless the kind is known |
| S3 | A scanned copy of a **Dubiz-issued** document is that document, not a second sale (`SAME_AS_DUBIZ_DOCUMENT`). | excluded |
| S4 | On a **register day** (any POS sale or Z for that business day), scanned income documents of that day are presumed printed from the register (`COVERED_BY_REGISTER`); the owner may mark one as outside the register (a decision). | excluded |
| S5 | A business with **no** register stream and **no** Dubiz-issued sales in the period: verified scanned tax invoices count as sales, labelled "from scanned documents". | counted |
| S6 | One sale per (issuer, kind, document number); one per file content. A re-scan, a second photo or a forwarded copy is the same document (`DUPLICATE_SCAN`). | first verified one counts |
| S7 | Currency must be known; an amount must be exact in minor units (no rounding of the Float). Unknown currency or inexact amount: not counted, reported. | not counted |
| S8 | Only documents the owner approved count; a later rejection (as for other evidence) excludes it. | — |

### Identification and matching

- **Against Dubiz documents (S3):** exact = issuer is the business AND (kind, number) equals an issued
  `BillingDocument`; probable = same total, currency and issue day ±1 with no number read → a proposed
  `SALE_SAME_AS_DOCUMENT`-style link the owner confirms. Until confirmed, the scanned document is excluded (errs
  toward under-counting, and says so).
- **Against register days (S4):** by business day of issue, per business; no per-sale matching is attempted.
- **Duplicates (S6):** `Document.contentHashSha256`, then (issuer tax id, kind, number), then (total, currency,
  issue day, counterparty) as a proposal only.
- **Receipt layer:** a scanned receipt (or the receipt part of an invoice-receipt) can be matched to a bank credit
  like any receipt; it never adds a sale.

### Test cases (to be written with the implementation)

1. Scanned tax invoice, business with nothing else → one sale. Same file uploaded twice → still one.
2. Scanned copy of a Dubiz-issued invoice (same number) → zero extra sales.
3. Scanned invoice with the same total and day as a Dubiz invoice, no number → excluded and proposed; confirmed
   "different" → counted.
4. Scanned invoice on a day with a Z → excluded; owner marks it outside the register → counted, and the day's
   variance is unaffected.
5. Scanned supplier invoice wrongly approved as "income" (issuer ≠ business) → not income.
6. Scanned receipt for an invoice already counted → money in only, sales unchanged.
7. Scanned credit note → refund of the matching scanned invoice; on a Dubiz invoice → no double refund.
8. USD amount, or 118.005 → not counted, reported.
9. Business with Dubiz invoices in the period and also scanned ones → S5 does not apply; scanned excluded unless
   individually confirmed as different.
10. Tenant isolation: a scanned document of another business can never match or be matched.

### What it needs (separate approval)

`FinancialRecord` cannot express S1, S2, S6 or S7 (no issuer, kind, number or currency; Float amount). Supporting
the rules needs a **schema change**. Recommended: a new revenue evidence table keyed to `Document`
(`businessId, documentId` composite) holding issuer tax id, kind, number, currency and minor-unit amounts, written
at approval, leaving `FinancialRecord` and its readers exactly as they are. The alternative — new columns on
`FinancialRecord` — changes an existing table and its writer. Either is a separate owner decision.

## Release plan

State on 2026-10-24, measured (not taken from earlier reports):

| Migration | Where | State | Evidence |
|---|---|---|---|
| everything up to `20261024090000_platform_admin_a1` | `main` | applied in Production | ledger audit run 39962847161 (185 rows, all finished) |
| `20261027090000_accountant_month_close` | `main` (#745) | **applied in Production** | `release-migrate` run 40119804303 (pending set = exactly 0927; applied); post-apply evidence run 40123890607 (17/17 PASS) |
| `20261025090000_currency_settings_fx_rates` | PR #756 | not merged, not applied; sorts before an applied migration | — |
| `20261026090000_payment_settlement_facts` | PR #769 (draft) | not merged, not applied; sorts before an applied migration | — |
| `20261028090000_revenue_truth_foundation` | PR #781 (draft) | not merged, not applied | — |

`release-migrate` applies only an exact prefix of the pending migrations in Prisma order
(`scripts/ci/release-migrate-gate.mjs`, PREFIX INVARIANT). The revenue migration has **no object dependency** on
0925 or 0926 (it names only `Business`, `Document`, `AcquisitionConnection`, `ExternalTransaction`,
`BillingDocument`; step 0 of the lab asserts it), and #784 uses neither FX rates nor settlement facts.

**Recommended order: #781 first, #756 / #769 left pending.** With them unmerged, merging #781 makes 0928 the only
pending migration on `main`, so it is the next one `release-migrate` can apply, with no gate bypassed. 0925 / 0926
already sort before the applied 0927 and so must be re-timed in any case (this repository's practice — #745 was
re-timed for the same reason); after 0928 they are re-timed after 0928 instead. The one risk fails safe: if #756 or
#769 were merged before 0928 is applied, they would be pending ahead of it and the gate would refuse 0928 (and their
own preflight ordering check would fail). So: **do not merge #756 / #769 before they are re-timed.**

The gate classifies 0928 as AUTHORITY-changing (`scripts/ci/migration-security-classifier.mjs`: GRANT, REVOKE, RLS,
POLICY), so it needs an approval record and a passing Production preflight. The evidence files are ready on #781:

- `ops/evidence/revenue-truth-foundation-preflight.sql` (14 checks): clean ledger; 0927 finished and nothing finished
  after 0928; none of the migration's objects exist; app_runtime and the five tables it builds on exist; the tenant
  keys its composite keys point at; the enum labels and columns its link guard reads; ExternalTransaction and
  BillingDocument under FORCE RLS; the evidence role sees every row.
- `ops/evidence/revenue-truth-foundation-production-evidence.sql` (20 + 2 checks): recorded and finished with the
  pinned sha256; RLS ENABLED + FORCED on all eight tables; exactly 16 per-command policies on the tenant GUC; the
  exact ACL of every table and sequence; no column privilege; the 20 composite tenant keys (through `businessId`)
  and the 2 plain keys validated; the 26 checks, 19 unique keys and 17 triggers; the three guard functions unchanged
  (body md5), not SECURITY DEFINER, EXECUTE held by nobody else; the 11 enums; no row, no flag, no revenue policy or
  trigger on an existing table.

Both are registered in `prod-readonly-evidence.yml` (two lines in its file list; nothing else in that workflow
changed) and proven in the lab (`revenue-truth-foundation-lab.yml`, steps 0b, 1, 2b).

Steps, each behind its own owner approval:

1. Merge #781 (migration only; nothing is applied by a merge).
2. Production preflight from `main` (`prod-readonly-evidence.yml` with the preflight file) → 14/14 PASS.
3. Approval record `ops/release-approvals/20261028090000_revenue_truth_foundation.json` (sha256, decision, approver,
   preflight run, `releaseSet: ["20261028090000_revenue_truth_foundation"]`).
4. `release-migrate` for exactly `20261028090000_revenue_truth_foundation` → environment approval → apply.
5. Post-apply evidence from `main` (the production-evidence file) → 22/22 PASS.
6. Only then merge #784 (code). Its migration-first verdict says "already in Production" because the migration is
   in the tree — the guard reads the repository, not Production; the order above is what makes it true. (If #784
   were merged early nothing would break at runtime — no product code queries the new tables — but the rule stands.)

## Open owner decisions (before any apply)

1. **0925 / 0926**: confirm they stay unmerged until re-timed (recommended order: 0928 first; see the release plan).
2. **Post-retention purge**: whether to build the designed (OFF) mechanism, and the policy inputs (periods per
   record family, filing dates, legal holds).
3. **Scanned income documents**: approve the specification and the schema route (new evidence table vs. columns
   on `FinancialRecord`) before anything is connected.
4. **Raw source payloads.** Only a SHA-256 of each source record is kept (`sourcePayloadHash`). Keeping the raw
   payload (or the original file, already possible through `documentId`) is a retention / privacy decision.
5. **Tolerances.** The read model reports Z vs. POS variance exactly; a tolerance for "closed with variance" is
   not set.
6. **Business day.** Callers pass the business day (Israel time). Late-night sales after midnight before the Z
   belong to the Z's day; the adapter rules for that are milestone B / D work.
