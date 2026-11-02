# Revenue report uploads — Z reports and card settlement reports

Status: infrastructure only. Behind `z_report_upload` / `settlement_report_upload` (both OFF). The parser registry
ships **empty**: until a real sample of a source system's report arrives, every upload is answered
`FORMAT_NOT_SUPPORTED` ("עדיין לא תומכים בקובץ מהמערכת הזו. שלחו לנו דוגמה…") and nothing is written.

## What it is

An owner uploads the file a register (Z report = daily close) or an acquirer / payment provider (settlement report)
exports. The pipeline is format-independent:

```
file ─► registry.select(kind, file)  ─► parser.parse ─► drafts ─► validate (table CHECKs in code)
     ─► dedupe in file ─► classify vs DB (NEW / EXISTING / CONFLICT) ─► preview + signed token
commit(token, decisions) ─► one tenant tx, advisory lock ─► ImportRun ─► recordDailyCloseInTx / recordSettlementInTx
```

| piece | file |
|---|---|
| contract (ZReportDraft, SettlementDraft, parser interface) | `lib/revenue-sources/uploads/contract.ts` |
| registry (shipped empty) | `lib/revenue-sources/uploads/registry.ts` |
| pure core (CHECK rules, keys, hashes, classification, decisions) | `lib/revenue-sources/uploads/core.ts` |
| service (analyze / commit / list) | `lib/revenue-sources/uploads/service.ts` |
| HTTP edge (session, flags → 404, Hebrew errors, no-store) | `lib/revenue-sources/uploads/http.ts` |
| routes | `app/api/money/revenue-reports/{route.ts, z/{analyze,commit}, settlement/{analyze,commit}}` |
| screens | `/money/revenue-reports` (list), `/money/revenue-reports/{z,settlement}/upload` |
| browser client | `lib/revenue-report-uploads/client.ts` |
| tests | `lib/revenue-sources/uploads/revenue-report-core.test.ts` (pure), `.rru/battery.ts` (lab DB) |
| CI | `.github/workflows/revenue-report-uploads-ci.yml` |

## Mapping onto the revenue truth tables

| draft | table | fixed by the pipeline |
|---|---|---|
| ZReportDraft | `RevenueDailyClose` + `RevenueDailyCloseTender` + `RevenueDailyCloseVat` | `sourceKind` POS; `capture` from the parser (FILE_STRUCTURED, or FILE_EXTRACTED for a PDF / image); `sourceScope` `upload.z.<parserKey>`; `externalId` `z:<zNumber>` or `day:<businessDay>`; `revision` 1 (or n+1 on SUPERSEDE); `sourcePayloadHash` = sha256 of the facts; `ingestRef` `importrun:<id>`; no `connectionId`, no `documentId` |
| SettlementDraft | `RevenueSettlement` | `sourceKind` ACQUIRER / PAYMENT_PROVIDER (the parser's); `capture` from the parser; `sourceScope` `upload.settlement.<parserKey>`; `externalId` from the report |

Every CHECK of those tables (token regexes, currency set, non-negative amounts, total = gross − discount − refunds −
voids, net = gross − fee − other, revision ⇔ supersedes, period order, VAT categories, installments) is checked in
`core.ts` first, so a bad row is reported to the owner by row and reason instead of failing the commit. Consistency
the tables do not enforce (tenders ≠ total, VAT lines ≠ VAT) is kept on the row as `validation = WARNINGS` +
`validationCodes`, never silently fixed.

**Schema: no change needed.** Nothing in the migration blocks uploads: `connectionId` is nullable with no trigger
requiring it for POS rows, the runtime holds SELECT / INSERT (all an append-only upload needs), the tenant FKs and
FORCE RLS apply as for any writer. The run ledger (`ImportRun`) is already used the same way by bank file import.

## Duplicates and conflicts

* **EXISTING** — the same facts are already recorded (same source key and facts hash; for a Z also the same facts on
  the same register and day from another source). Skipped. Replaying a file is idempotent at two levels: the run's
  retry key (business, file hash, parser identity[, decisions]) and each row's unique source key.
* **CONFLICT** — recorded with different facts. Never overwritten, never decided by default; commit is refused
  without a decision for every conflict:
  * `SAME_Z` (same register + Z identity): SKIP, or SUPERSEDE → revision n+1 with `supersedesId` = the chain's latest
    revision (the read model then counts only the latest revision).
  * `SAME_DAY` (another Z of that register and day): SKIP, or ADD → a separate Z (e.g. a second shift).
  * `SAME_SETTLEMENT`: SKIP only — a settlement has no revision column. A real correction would be a REJECTED
    `RevenueDecision` on the old row plus a new row; not built here.
* Same key twice in one file: identical → read once; different → both invalid (`CONFLICT_IN_FILE`).

## The file is not stored

Only its sha256 (`ImportRun.contentHash`) is kept, as in bank file import. The screens say so.

## Double counting — verified

* These rows **never create a FinancialRecord, FinancialEvent, BillingDocument, PaymentTransaction or
  ExternalTransaction**. The service has no write but the two store writers and the run ledger (static check in the
  core test); the battery proves those five tables byte-identical before and after.
* Nothing in the product sums them with documents: the list screen shows each report as it was recorded, sums nothing,
  and is labelled "דוחות, לא רישומי הכנסה". No dashboard, report or learning engine reads them.
* `lib/revenue-truth/read-model.ts` (still connected to nothing) is where they would meet. Its rule: revenue is
  recognised at the sale layer from ONE source per register day — an effective Z counts the day (closedNet) and that
  day's POS sales are only compared. **A Dubiz BillingDocument (tax invoice / invoice-receipt) is counted as a sale
  on its own (documentNet) unless a CONFIRMED `SALE_SAME_AS_DOCUMENT` link says it is a register sale.** So for a
  business that also issues Dubiz invoices for till sales, Z + invoice WOULD both count in the read model until those
  links exist — a matching feature, deliberately not built here. A Z with `capture = FILE_EXTRACTED` counts only
  after a CONFIRMED decision on it (CLOSE_AWAITING_CONFIRMATION); a FILE_STRUCTURED Z counts as recorded.
* Settlement vs bank: a settlement is layer 3 (what the acquirer credited, gross / fee / net); the bank CREDIT line
  (`ExternalTransaction`) is layer 4. They are the same money at two stages, connected only by a
  `RevenueLink SETTLEMENT_DEPOSITED_AS` (settlement → bank credit, ≤ net). Settlements never add to sales in the read
  model. No matching is built here.

## Feature flags and release

* Catalog: `z_report_upload`, `settlement_report_upload` — `defaultEnabled: false`.
* Data migration (separate PR-1 under the migration-first rule):
  `prisma/migrations/20261111090000_revenue_report_upload_features/migration.sql` — one definition + one policy row
  per key, `globalEnabled false`, `ON CONFLICT DO NOTHING`. Rollback (only while no `BusinessFeatureAccess` row names
  the keys):

  ```sql
  DELETE FROM "PlatformFeaturePolicy"     WHERE "featureKey" IN ('z_report_upload', 'settlement_report_upload');
  DELETE FROM "PlatformFeatureDefinition" WHERE "key"        IN ('z_report_upload', 'settlement_report_upload');
  DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111090000_revenue_report_upload_features';
  ```

  With the rows gone the resolver falls back to the catalog default (OFF).
* While a kind is OFF for a business: its routes answer 404, `/money/uploads` shows its card as "בקרוב". ON (a
  per-business override): the card links to the upload screen.

## Adding a source system (blocked on real samples)

1. Get a real export from the system (and, for PDFs, decide FILE_EXTRACTED).
2. Write `lib/revenue-sources/uploads/parsers/<key>.ts` implementing `ZReportParser` / `SettlementParser`; `detect`
   must be specific (signature of that export), `parse` must emit row errors rather than guess.
3. A fixture test built from the (anonymised) real sample.
4. Add it to `SHIPPED_PARSERS`, update the "No vendor parser…" CI step and the core test's file-list check.

Open questions per source that only a sample answers: which register identity the file prints, whether a Z number
exists, whether refunds / voids are separate or netted, tender breakdown labels, VAT lines, the acquirer's settlement
id and whether a file lists transactions or credits (a transaction list is NOT a settlement).
