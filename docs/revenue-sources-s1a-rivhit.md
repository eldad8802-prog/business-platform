# Revenue sources S1-A — Rivhit (read-only)

Owner approval 2026-10-26: development, tests, a separate migration (not applied) and draft PRs. Everything stays OFF
(`pos_rivhit`). This milestone does **not** include:

- applying the migration;
- merging;
- connecting a real business or running a pilot (a future pilot would run only in business 9, after explicit approval);
- PayPlus (S1-B);
- matching;
- any home-screen, payables, retention or deletion change.

## What it does

A business that uses Rivhit Online connects with the `api_token` it generates in Rivhit. Dubiz then reads its sales
documents and receipts into **revenue truth**:

| What Rivhit has | What it becomes |
|---|---|
| a sale document (a type the owner confirmed as SALE) | `RevenueSale` SALE + one `RevenueReceipt` per tender (cash included) |
| a credit document (REFUND) | `RevenueSale` REFUND + its tenders, money out |
| a document cancelled after it was read | `RevenueSale` VOID naming the sale (same money); the sale is never changed |
| a standalone receipt (RECEIPT) | `RevenueReceipt` per tender, no sale |
| a receipt cancelled after it was read | each of its tenders REJECTED (actor SYSTEM, reason `SOURCE_CANCELLED`); rows are kept |
| an invoice-receipt's mirror receipt (MIRROR) | nothing: its tenders come from the document |
| orders, quotes, delivery notes, purchases (IGNORE) | nothing |

## Two contracts: register data and card data are different truths

`lib/revenue-sources/contract.ts` has two shapes:

- **`PosDocument`** is what was **sold**. It becomes a sale, plus receipts.
- **`PaymentEvent`** is what was **charged on a card**. It becomes a CARD receipt only, and **never a sale**.

A payment provider that only clears cards cannot stand in for the till. PayPlus (S1-B) will implement `PaymentEvent`.

**Origin.** A document is `REGISTER` only when the source proves it came from a till. Otherwise it is
`OFFICE_OR_UNKNOWN` and is written with `sourceKind = ACCOUNTING_APP`, **never `POS`**.

## The open question: are register sales visible through the API?

This is **not proven**. Rivhit says its "קופה רושמת" module syncs to Rivhit Online in real time, but neither the
documentation nor the demo account shows how a till's document differs from an office document:

- **Documentation:** no register, branch or Z endpoint, and no register field anywhere. `agent_id`, `project_id` and
  `storage_id` are the only candidates.
- **Demo account:** 25 document types, none named as a till type. `Document.Details` has no register or branch field.

So the adapter reads Rivhit's **documents**, labels them ACCOUNTING_APP, and keeps `registerTypes` empty. If Rivhit
confirms a discriminator, the owner can name till-only types and those documents become POS. The status endpoint
reports `registerProven: false` until then. Questions for Rivhit are in the owner's report.

## How it reads

Rivhit documents no webhook for documents, so reading is by polling. Every run is bounded:

- at most 60 Rivhit calls per connection;
- calls are paced under Rivhit's 200 per minute;
- every list is small (no paging, 30-second cap).

Each run does three things:

1. **Forward.** For each confirmed type, Dubiz asks for the numbers after the cursor (`Document.List` / `Receipt.List`
   by number range). The issue date cannot be the cursor, because documents may be dated ahead. If the window comes
   back empty, Dubiz makes an open-ended look, at most hourly (with the rescan), so a numbering jump cannot stall the
   cursor and the steady state costs one list call per type. Each new number is read in full (`Details`) and handed to
   intake. The cursor advances row by row and passes only what was handed over or recorded as unreadable, so an outage
   in the middle of a run loses no progress.
2. **Rescan, hourly.** Dubiz re-reads the last 7 days by date, looking for cancellations of what it already read.
   Rivhit has no "changed since" filter.
3. **Backfill, only on the owner's request.** History is read day by day (at most 366 days back). Each finished day
   is checked against `Company.SummaryReport`: count and VAT-inclusive total per type, cancelled documents included.
   On the demo account this matched for 11 of 11 types to the agora.

On confirmation, the cursor starts at each type's last number (`Document.Last` / `Receipt.Last`). History is read
only through a backfill.

## Where it sits

- **Connection.** `AcquisitionConnection` with source `pos.rivhit`:
  - `externalResourceId` is the Rivhit company id. The partial unique index means one company can be live on only one
    business.
  - The `api_token`, the type roles and the sync state live in the **encrypted** credential bundle (AES-256-GCM, bound
    to the row), like the WooCommerce and Wix pollers' cursors. There is no cursor column.
- **Intake.** The poller hands receipts to `ingestAcquisition`, which applies the gate (feature on, business active)
  and dedupes by receipt identity. Each receipt has family `CUSTOM` and target `revenue`.
  - Rule **R10_REVENUE** sends it to the adapter's `route()`. It is never a Lead or an order, and no identity is
    resolved.
  - The payload is the normalized document: amounts, tenders, dates and an item reference. It holds no customer name,
    phone, email or item text.
- **Revenue truth.** Writes use `recordSale`, `recordReceipt` and `recordDecision`. All are idempotent and
  append-only, keyed in the scope `pos.rivhit:c<connectionId>`. A changed fact under the same key is a CONFLICT and
  writes nothing.
- **Sweeper.** `runIntakeSweep` calls `syncRivhit(businessId)` inside the tenant job, before the drain. A Rivhit
  failure never stops the drain.
- **Owner API.** `/api/integrations/pos/rivhit` supports GET (status / list), POST (connect) and PATCH
  (`confirm_types`, `backfill`). It answers 404 while the feature is off. There is no screen in S1-A.
- **Errors.**
  - Only a token Rivhit rejects turns the connection to ERROR (`RIVHIT_TOKEN_REJECTED`), because the owner must act.
  - Outages are retried by the next run.
  - A document that cannot be read goes on the owner-visible `unreadable` list; it is never dropped silently.
- **Currency.** A foreign-currency document is recorded from its NIS totals (`document_total`, `total_vat` and payment
  amounts are NIS) and is never converted.

## Proof

| Check | Result |
|---|---|
| `lib/revenue-sources/rivhit/rivhit-core.test.ts` | 70/70. Pure, fake fetch. |
| `.s1a/battery.ts` | 54/54 on the Production-topology lab, as the NOBYPASSRLS runtime, with a fake Rivhit. |
| `lib/intake/routing/s1a-compat.test.ts` + the CI `compat` job | Routing identical to routing-policy@2 except CUSTOM + revenue; the unchanged M6, M7-A and M7-B/C batteries pass on a database with the S1-A migration. |
| `scripts/revenue-sources/rivhit-demo-probe.ts` | Run locally against Rivhit's documented demo account, read-only and counts only. Results below. |
| Migration lab (PR-A) | `.s1a/lab.sh` and `pos-rivhit-source-lab.yml`. |

The battery covers:

- connect, confirm and sync;
- replays and cancellations;
- receipts and mirror receipts;
- backfill with day checks;
- unreadable documents;
- tenant isolation, the flag, a rejected token and a revoked connection;
- the absence of personal data;
- acceptance: an outage in the middle of a run (resumed with no gap and no duplicate), a backfill completed across
  several budget-bounded runs, a numbering jump, the real intake sweeper (enabled business polled, disabled one not),
  and the read model (Rivhit rows never register sales — requires #848).

Demo probe results (2026-10-25):

- 171 documents, 11/11 day checks;
- 60/60 sampled documents parsed;
- 30/30 sampled receipts parsed;
- no till field.

## Known limits (S1-A)

- **Register proof:** see above.
- **No register key.** `registerKey` is null, so there is no per-register Z. Rivhit's daily summary is a completeness
  check, never a `RevenueDailyClose`.
- **A cancelled sale's tenders are not reversed.** There is no evidence the money was returned. The sale's VOID nets
  the sale.
- **Line items are carried but not stored.** Revenue truth has no line table. Storing them is a separate decision.
- **The revenue read model** used to treat every `RevenueSale` as a register sale. #848 fixes it: only POS forms
  register days; Rivhit rows (ACCOUNTING_APP) are shown apart. S1-A therefore depends on #848 (merged into this branch;
  release order in `docs/revenue-sources-s1a-release-plan.md`).
