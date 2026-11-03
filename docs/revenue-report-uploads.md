# Revenue report uploads — Z reports and card settlement reports

Status: infrastructure only. Behind `z_report_upload` / `settlement_report_upload` (both OFF). The parser registry
ships **empty**: until a real sample of a source system's report arrives, every upload is answered
`FORMAT_NOT_SUPPORTED` ("עדיין לא תומכים בקובץ מהמערכת הזו. שלחו לנו דוגמה…") and nothing is written.
The owner's approved directions of 2026-11-03 are implemented in the lab as rules (see "Owner decisions" below);
**Z and settlement uploads stay blocked from activation until verified against original samples.**

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
  * `SAME_SETTLEMENT`: SKIP only while a recorded version is live — a settlement has no revision column. A correction
    is a REJECTED `RevenueDecision` on the recorded row, then the corrected upload: NEW, stored as `<id>#c<n>` beside
    the rejected row (D-4 below).
* Same key twice in one file: identical → read once; different → both invalid (`CONFLICT_IN_FILE`).

## The file is not stored

Only its sha256 (`ImportRun.contentHash`) is kept, as in bank file import. The screens say so. The approved direction
is to keep the original (D-9); the proposed design (not built, needs a schema change and the owner's approval) is
"Original file storage — design" below. Retention is NOT decided.

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
  links exist (D-1: kept so on purpose — the view now warns `POSSIBLE_DUPLICATE_CLOSE_AND_DOCUMENT`). A Z with an
  unresolved HOLD overlap (D-2 / D-12) counts only after a CONFIRMED decision; a same-amount suspicion only asks (it
  removes nothing). A Z with `capture = FILE_EXTRACTED` counts only
  after a CONFIRMED decision on it (CLOSE_AWAITING_CONFIRMATION); a FILE_STRUCTURED Z counts as recorded.
* Settlement vs bank: a settlement is layer 3 (what the acquirer credited, gross / fee / net); the bank CREDIT line
  (`ExternalTransaction`) is layer 4. They are the same money at two stages, connected only by a
  `RevenueLink SETTLEMENT_DEPOSITED_AS` (settlement → bank credit, ≤ net). Settlements never add to sales in the read
  model. Matching is only PROPOSED (D-6, `deposit-proposals.ts`, not connected); nothing counts until confirmed.

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

## Reading values (format-independent, `report-values.ts`)

Every parser reads printed amounts and dates through `readAmount` / `readDate` — exactly, or a row error code:

* **Amount → bigint minor units.** ₪ / ש״ח / NIS and direction marks are ignored. The **decimal mark is stated by
  the parser** (`"."` → `1,234.50`, `","` → `1.234,50`) and never inferred: `12,50` under `"."` is
  `SEPARATOR_MISMATCH`, not 1250 and not 12.5. Thousands marks must be groups of three; at most two decimals.
  Negative = leading or trailing minus (also U+2212) or parentheses.
* **Refunds, voids, discounts, fees are magnitudes** (`asDeduction`): a report may print them `150.00` or `-150.00`.
  The draft's own CHECK (total = gross − discount − refund − void; net = gross − fee − other) is what catches a column
  read the wrong way — never an adjustment.
* **Date → YYYY-MM-DD as printed.** Day-first (`/ . -`, two-digit year = 20YY) or ISO when the parser states `YMD`.
  Month-first is never read. A printed time is returned but **never moves the day** (D-10: the printed day; no cut-off hour).
* `linesDifference(total, lines)` reports the gap between tenders / VAT lines and the printed total; it adjusts
  nothing.

Proof: `report-values.test.ts` (synthetic values; proves the reading rules, **not** any vendor's format).

## Verification plan — when a real sample arrives

Per source system, before its parser enters `SHIPPED_PARSERS`:

1. **Intake.** The original export as the system produced it (CSV / XLSX / PDF, not re-typed, not re-saved), 2–3
   different days incl. one with a refund or cancellation. Kept outside the repository; the fixture is an anonymised
   copy that keeps the layout, the labels and every field listed in "Sample request" below.
2. **Hand-written expectations first.** From the printed report, before any code: business day, Z number, register,
   gross / discount / refund / void / total, VAT, each tender, transaction count (Z); acquirer id, value date, gross /
   fee / other / net, installments (settlement). Stored next to the fixture as `EXPECTED`.
3. **Parser + fixture test.** `detect` keyed on that export's signature (and 0 for the other kinds' fixtures);
   `parse` must reproduce `EXPECTED` exactly; tenders and VAT lines must add up (`linesDifference = 0`) or the row
   is an error; the refund day must pass the total CHECK with the refund in its own field.
4. **Idempotency.** The same file twice → every row EXISTING, 0 writes; one day edited → CONFLICT needing an owner
   decision (no default).
5. **Double counting (battery).** FinancialRecord / FinancialEvent / BillingDocument / PaymentTransaction /
   ExternalTransaction byte-identical before and after.
6. **Lab end-to-end** in the synthetic lab business, through the screens, NOBYPASSRLS runtime; cross-business
   access denied.
7. **Production pilot** only after the data migration (#918) and an owner go: business 9 only, before/after
   read-only evidence, the owner's real file preview-only unless the owner approves import.
8. Synthetic files are never evidence of vendor compatibility.

## Sample request

**Z report** — must survive redaction: business day; Z number; register / terminal id (may be masked but
consistent); period start / end; gross; discounts; refunds and voids **as printed, separately**; net total; VAT total
and VAT lines by rate (taxable + VAT, zero-rated / exempt); grand total if printed; transaction count; every tender
line with amount and count (cash, credit — incl. per-brand lines, cheque, transfer, wallet, voucher, other); currency.

**Settlement report** — must survive: acquirer / provider; settlement or batch id; value (credit) date and the
transaction / batch date if printed; gross; commission / fee; other deductions; net; installment number / count;
currency; card brand, chargebacks, terminal / merchant number (last 3–4 digits) — the last three have no column yet
and decide whether one is needed.

**May be redacted:** business name, tax id, address, full merchant / terminal numbers (keep the last 3–4 digits), card
numbers, customer names. Also tell us which system and which report / menu the file came from.

## Owner decisions (approved directions 2026-11-03; round 2 the same day)

**What the tests prove.** Every rule below is proven on SYNTHETIC drafts, files and rows only
(`revenue-report-core.test.ts`, `report-values.test.ts`, `lib/revenue-truth/read-model.test.ts`, `.rru/battery.ts`).
Synthetic tests prove the rules, **not** that any real Z or settlement export is read correctly. The parser registry
stays empty, both flags stay OFF, and **Z and settlement uploads stay blocked from activation until each source is
verified against original samples** ("Verification plan" above). No original sample exists, so the last column below
is "no" for every item.

Columns: **rule tested in lab** = a pure test and / or the lab battery (PG, Production role topology, NOBYPASSRLS
runtime) proves the rule · **wired to UI & data** = the upload screen / routes / database path carry it end to end (all
behind the OFF flags and the empty registry, so no owner can reach it yet) · **proven on an original file** = checked
against a real export of a real source system.

| D | Direction | Rule tested in lab | Wired to UI & data | Proven on an original file | Where |
|---|---|---|---|---|---|
| D-1 | Sales source per business AND register; double counting prevented only by an IDENTIFIED overlap | yes (read-model D-1 tests; core "confirm:" tests; battery L1) | partly — data path: the read model is connected to nothing; UI: every Z upload asks for and requires the per-register sales-source confirmation (interim, below). The standing definition is a **proposal** (schema) | no | `read-model.ts` (confirmed `SALE_SAME_AS_DOCUMENT` only; `POSSIBLE_DUPLICATE_CLOSE_AND_DOCUMENT`); `core.ts checkZConfirmation`; `service.ts` commit; `upload-screen.tsx` |
| D-2 | A Z already recorded as a financial document stops further counting until the user resolves it | yes (core D-2; read-model D-2; battery K) | data: preview `overlaps` (basis + effect) and the read-model loader (`sources.ts`); UI: the row shows "ממתין להחלטה" / "שאלה". The read model itself is connected to no screen | no | `overlap.ts` `Z_DOCUMENT_SAME_DAY` → HOLD; `read-model.ts` `CLOSE_OVERLAP_UNRESOLVED` |
| D-3 | Keep the income-documents path; settle the overlap before Z is enabled | yes (static: the approve route is unchanged) | yes (nothing changed in documents) | no | `app/api/documents/[id]/approve` untouched |
| D-4 | Correct a settlement by reject + re-upload; history kept; never both counted | yes (core D-4 incl. the `<id>#c<n>` bijection; read-model D-4; battery K + L4 a–f, concurrency) | data: yes (service + store + read-model loader); UI: the preview row carries `corrects`, the screen does not render it yet | no | `core.ts classifySettlement` / `CORRECTION_SUFFIX`; `service.ts` lock + re-classify; `read-model.ts latestVersions` |
| D-5 | Stage one: batch / deposit SUMMARY only | yes (core; battery K) | yes (422 + Hebrew text on analyze and commit) | no | `contract.ts SettlementFileShape`; `service.ts`; `http.ts` |
| D-6 | System PROPOSES settlement ↔ deposit matches, user confirms; exact only | yes (read-model D-6) | no (pure proposer, connected to nothing) | no | `lib/revenue-truth/deposit-proposals.ts` |
| D-7 | No expense from a settlement's fee in stage one | yes (static + battery J/K) | yes (no writer exists) | no | fee on the settlement row only |
| D-8 | Every Z difference shown; tolerance only per a parser's proven precision (default 0) | yes (core; read-model) | data yes (preview `differences`); UI: warnings shown, `differences` not rendered | no | `ParserBase.roundingToleranceMinor`; `ZRow.differences` |
| D-9 | Keep the original uploaded file; retention NOT decided | no (design only) | no | no | "Original file storage — design" below (schema change proposed) |
| D-10 | Use the printed business day; if missing ask; NO cut-off hour | yes (core; battery K) | data yes (NEEDS_INPUT / INPUT_REQUIRED, `answers` form field); UI: the screen does not render `questions` yet | no | `core.ts resolveZDrafts` |
| D-11 | Missing register → the single DEFINED register, else ask; never invent | yes (core; battery K, L1) | data yes; UI: confirmation of every register's sales source on every upload (interim); register definitions are a **proposal** (schema) | no | `resolveRegisterKey`; `checkZConfirmation`; proposal below |
| D-12 | Stop overlapping counting against imported history; per source and register; dates alone never block a period | yes (core D-12; read-model D-12; battery L3 for the reader's isolation) | **no — disabled**: the reader exists on the branch behind the literal `IMPORTED_HISTORY_OVERLAP_ENABLED = false`; the loader never reaches it | no | `overlap.ts`; `lib/data-transfer/historical/historical-overlap-reader.ts`; firewall entry (below) |
| D-13 | Reports first; sales / settlements / deposits separate, never summed | yes (read-model D-13) | no (pure shape, connected to nothing) | no | `lib/revenue-truth/layers-report.ts` |

Not wired to any screen yet: `questions` (D-10/11 answers), `differences`, `corrects`. Wired this round: the
per-register sales-source confirmation and the overlap notes on each Z row.

## Z duplicate suspicion (round 2)

Same day + same amount is **not proof**. Allowed: stop for clarification. Not allowed: remove a sale from the count, or
mark an overlap confirmed, without the owner's decision or a certain link. Every overlap now carries a `basis` and an
`effect` (`lib/revenue-sources/overlap.ts`):

| basis | what it is | effect |
|---|---|---|
| `Z_DOCUMENT_SAME_DAY` | an approved income document of the Z's day whose text reads as a Z (the documents Z-guard's phrases) — "a Z was already recorded as a financial document" (D-2) | **HOLD**: the Z is recorded but not counted until the owner's decision on it (CONFIRMED counts it; REJECTED leaves it out) |
| `HISTORY_SAME_DAY` | imported history issued on the Z's day (D-12) — read only once the reader is switched on | **HOLD**, same way, per Z |
| `AMOUNT_SAME_DAY` | an approved income document of that day for exactly the Z's total, whose text does NOT read as a Z | **QUESTION**: nothing is held, excluded, merged or confirmed; the Z counts as it would; the read model warns `CLOSE_DUPLICATE_SUSPECTED` (until the owner decides on that Z); the preview row says so |

Before this round the exact-total match alone held the Z out (it was treated like D-2). That is changed: it is now a
question only. Proof: core "suspicion:" checks; read-model "suspicion" checks (the Z closes its day, nothing excluded,
the question names the Z and the document, only the owner's decision ends it, a HOLD and a QUESTION together → the
HOLD decides); battery L2 (an ordinary invoice of the same day and amount: the Z counts 7000, not excluded, not waiting,
`CLOSE_DUPLICATE_SUSPECTED`; FinancialRecord, RevenueDecision and RevenueLink unchanged). Static: neither
`overlap.ts` nor `read-model.ts` can decide, link or write anything. The FinancialRecord side is never touched by any
of this; the read model does not count FinancialRecords at all.

## Registers and sales source

**Interim (built, round 2).** No standing definition of a business's registers or of a register's sales source exists.
So on **every** Z upload the owner selects and confirms, for every register in the file, how that register's sales are
recorded (`core.ts checkZConfirmation`, `service.ts` commit, form field `confirmation`, upload screen):

* `THIS_Z_REPORT` — this Z is how the register's sales are recorded. Recorded.
* `INVOICES_OR_OTHER_SYSTEM` — the sales are already recorded another way. Recording the Z as a sales source would
  count the day twice and there is nowhere to record "comparison only", so the commit is refused
  (`SALES_SOURCE_NOT_SUPPORTED`, Hebrew), nothing written.

Nothing is preselected or remembered; no confirmation / an unticked one / one missing a register → 409
`CONFIRMATION_REQUIRED`; a register not in the file or an unknown choice → 400 `CONFIRMATION_INVALID`; a confirmation on
a settlement → 400. The confirmation is part of the run's `decisionsHash` (audit). Battery L1 proves all of it on the
lab database; the next upload asks again.

**Joint proposal (NOT applied — schema change for approval).** One place for both D-11 (which registers a business has)
and D-1 / D-12 (each register's standing sales source, and whether a history source overlaps it). Append-only
decisions, like `RevenueDecision`; the latest effective one wins; never inferred from a report.

```prisma
/// A register (till / terminal) the business DEFINED. Owner-maintained; a report's register must match one.
model RevenueRegister {
  id          Int      @id @default(autoincrement())
  businessId  Int
  /// The token the reports print (same CHECK as RevenueDailyClose.registerKey).
  registerKey String
  label       String   @default("")
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([businessId, id])
  @@unique([businessId, registerKey])
}

enum RevenueSalesSource {
  /// The register's Z reports are its sales (the read model counts the day from the Z).
  Z_REPORT
  /// The register's sales are Dubiz tax invoices issued per sale (a Z is comparison only).
  DUBIZ_DOCUMENTS
  /// Another system records them (a Z is comparison only).
  OTHER_SYSTEM
}

/// The owner's STANDING decision for one register (and, optionally, one source scope / history system) from a day on.
/// Append-only: a change is a new row superseding the previous one.
model RevenueRegisterSalesSource {
  id              Int                @id @default(autoincrement())
  businessId      Int
  registerId      Int
  /// NULL: every source; else e.g. "upload.z.<parser>" or "history:<sourceSystemCode>" (D-12 per source).
  sourceScope     String?
  salesSource     RevenueSalesSource
  /// D-12: does imported history from `sourceScope` cover this register's sales? NULL: not decided (ask, hold the Z).
  historyOverlaps Boolean?
  effectiveFrom   DateTime           @db.Date
  supersedesId    Int?               @unique
  actor           String             // OWNER_USER — never SYSTEM
  decidedByUserId Int?
  createdAt       DateTime           @default(now())

  @@unique([businessId, id])
  @@index([businessId, registerId, effectiveFrom])
}
```

Migration (sketch): both tables FORCE RLS with the tenant SELECT / INSERT policies; `RevenueRegister` also an UPDATE
policy for `label` / `active` only; FKs `(businessId, registerId) → RevenueRegister(businessId, id)` and
`(businessId, supersedesId) → RevenueRegisterSalesSource(businessId, id)`; CHECK `actor = 'OWNER_USER'`; the runtime
gets SELECT / INSERT (and UPDATE on `RevenueRegister(label, active)`); the erasure coverage registers both models.
What it would change: `resolveRegisterKey` gets the defined list (single register → no question); the confirmation step
is skipped only for a register whose standing decision covers the upload's day and scope; `DUBIZ_DOCUMENTS` /
`OTHER_SYSTEM` Z reports become recordable as comparison-only evidence (the read model reads the standing decision
instead of counting them); `historyOverlaps = false` lets a Z count on a history day without a per-Z decision.
Decisions needed: approve the model; who may change a standing decision (owner only?); whether a change may apply to
past days (`effectiveFrom` in the past).

## Imported history: the overlap reader (D-12)

Built on this branch, **disabled**. The general firewall (`historical-fiscal-persistence.verify.test.ts`) is not
weakened: it still requires the exact list of files that may name the model, and a probe file naming it anywhere else
still fails it ("a new consumer appeared"). Exactly one entry is added, with its own rule:

* `lib/data-transfer/historical/historical-overlap-reader.ts` — `readHistoryOverlapInTx(tx, businessId, {fromDay, toDay})`:
  one `findMany`, select exactly `id, originalIssueDate, totalAmount, currency, sourceSystemCode` (no customer
  snapshot, number, allocation, document or reversal link), `where: { businessId, originalIssueDate in range }`, at most
  62 days and 5000 rows, and it first proves the caller's transaction carries THIS business's tenant GUC
  (`current_setting('app.current_business_id')`, else `NOT_IN_TENANT`). No global client, no raw write.
* Its only product caller is `lib/revenue-sources/overlap.ts`, which reaches it only while
  `export const IMPORTED_HISTORY_OVERLAP_ENABLED = false;` is true — a literal, not an environment variable.
* The verifier holds the reader to each rule by reading its source (one verb, the five fields, `businessId` in the
  where, the GUC check, the bounds, one caller, the literal false).
* Battery L3 (lab, FORCE RLS exactly as the i8a migration sets it): inside business L's tenant transaction the reader
  returns L's rows only, five fields; asking for B inside L's transaction or with no tenant → `NOT_IN_TENANT`; B's rows
  are invisible under L's GUC; a long range is refused; the runtime cannot UPDATE history; and with the literal false
  the real loader and the read model do not read history at all.

**Is listing it in the firewall the owner decision?** The verifier says a new consumer "is a decision for its own
increment". So the entry is on the branch but the reader is OFF; **activating it = approving this exact diff and then
changing the literal to `true`** (a reviewed commit). The exact firewall diff:

```diff
@@ const ALLOWED_TO_NAME_IT = [
   "lib/knowledge/coverage/feature-coverage.ts",
+  // Revenue report uploads (PR #919, D-12): the revenue OVERLAP reader. … NOT ACTIVE: its only caller reaches it
+  // behind a literal `false` (IMPORTED_HISTORY_OVERLAP_ENABLED in lib/revenue-sources/overlap.ts) …
+  "lib/data-transfer/historical/historical-overlap-reader.ts",
 ];
+check("the revenue overlap reader reads five columns of ONE business in its tenant transaction, and is off", () => {
+  // one findMany; no create/update/upsert/delete/executeRaw/queryRawUnsafe/@/lib/prisma/PrismaClient;
+  // select = [currency, id, originalIssueDate, sourceSystemCode, totalAmount]; where { businessId, … };
+  // current_setting('app.current_business_id', true) checked → NOT_IN_TENANT; bounded;
+  // callers = [lib/revenue-sources/overlap.ts]; IMPORTED_HISTORY_OVERLAP_ENABLED = false
+});
```

The accessor is the whole of `historical-overlap-reader.ts` (≈90 lines, quoted in the PR). The activation diff, after
approval, is one line: `-export const IMPORTED_HISTORY_OVERLAP_ENABLED = false;` / `+… = true;` (and the verifier's
"is off" assertion flipped). `.rru/lab.sh` now applies the i8a RLS block to the lab so the battery runs against
Production's policy. History has no register: until the joint proposal above exists, a HOLD on a history day is per Z.

## Settlement corrections under concurrency (D-4)

The link `<id>#c<n>` (n ≥ 2): a report id shaped like a stored correction (`#c2`, `#c10`…) is refused
(`EXTERNAL_ID_RESERVED`), so `settlementBaseIdOf` is a function on stored ids and `(base, n) → <base>#c<n>` its inverse
(core "bijection" check, incl. look-alikes `#c`, `#c1`, `#c01`, `#c0`); an id too long to carry a suffix stays a
SKIP-only conflict, never truncated. What makes it hold under concurrency:

1. **The service lock.** Every commit takes `pg_advisory_xact_lock(revenue-report:<kind>:<business>)` and then
   classifies AGAIN under the lock (`service.ts` commit). Two different corrections of the same rejected settlement,
   both previewed as `#c2` and committed at once → exactly one is recorded; the other sees a live `#c2` and is refused
   (`DECISIONS_REQUIRED`) — battery L4b. The same correction committed twice at once → one run, the other a replay
   (L4c).
2. **The unique key** `(businessId, sourceScope, externalId)`: below the lock, two raw writers inserting the same
   `<id>#c2` at once → one CREATED, the other `CONFLICT` (insert … ON CONFLICT DO NOTHING waits, then sees the row; the
   service turns that into `STATE_CHANGED` and rolls the whole commit back) — L4d.
3. **Not yet rejected.** A correction uploaded while the original is live is a SKIP-only `SAME_SETTLEMENT` conflict,
   never a correction; commit without a decision is refused; nothing written — L4a. Rejected after the preview, revived
   before the commit → re-classified under the lock → refused — L4f.
4. **The read side.** If a rejection is REVOKED after its correction exists (the store allows REJECTED → REVOKED), two
   versions are live; the read model counts only the latest (`latestVersions`, by versionKey = scope + base id) and
   warns `SETTLEMENT_VERSIONS_BOTH_LIVE` — L4e, and read-model D-4.

**Verdict:** sufficient — no double counting under any tested interleaving, and the history is kept. Residual (not a
double count): the order of versions is the insert order (id), and "which version is right" after a revoked rejection is
surfaced as a warning, not decided. **Optional hardening (schema change, NOT applied, not required):**

```prisma
 model RevenueSettlement {
   …
+  /// D-4: 1 for a report's first version; n for its n-th (each earlier one REJECTED). Replaces the "#c<n>" suffix.
+  revision     Int  @default(1)
+  supersedesId Int? @unique
-  @@unique([businessId, sourceScope, externalId])
+  @@unique([businessId, sourceScope, externalId, revision])
 }
```

with CHECK `(revision = 1) = (supersedesId IS NULL)`, FK `(businessId, supersedesId) → RevenueSettlement(businessId,
id)`, and a backfill `externalId = base, revision = n` for `#c<n>` rows. `supersedesId @unique` would make "two
corrections of the same version" impossible in the database itself (today the lock + re-classification do it).

## Original file storage — design (D-9; NOT built; retention NOT decided)

**Infrastructure reused.** The existing `StorageService` (`lib/storage`; R2 in Production, the local adapter in
development), exactly as CRM attachments, trust documents, billing PDFs and accountant packages use it: server-built
keys `biz/{businessId}/{domain}/…` validated by `assertSafeStorageKey`, metadata `{businessId, domain, visibility}`
checked by the domain policy. **A new private domain `revenue-reports`** (`lib/storage/types.ts` STORAGE_DOMAINS +
`domain-policy.ts`: default and required visibility `private`) — never `getPublicUrl`, never a presigned link handed
to a browser (an accountant presigned URL reveals its key; and all domains share one bucket — the open item in the
R2 public-access check: the bucket's r2.dev public access must stay disabled).

**Not a hidden `Document` row.** `Document` is read by at least 18 product files (e.g. `app/api/documents/inbox/route.ts`,
`app/api/documents/[id]/process/route.ts` (OCR), `lib/accountant/period-facts.ts`, `lib/accountant/change-hooks.ts`,
`lib/data-transfer/documents/documents-export.ts`, `lib/documents/pending-review.ts`, `lib/services/tasks/sources.ts`,
`lib/services/documents/document-duplicate.ts`, `lib/business-status/loaders.ts`, `lib/knowledge/outcomes/outcome-store.ts`
— 30 read sites; list: `git grep -nE "(prisma|tx|db)\.document\.(findMany|findFirst|count|groupBy|findUnique)" -- app lib`)
plus the erasure manifest. Proving each excludes a hidden row is not possible without touching every one, so the
design does not use `Document` (and leaves `RevenueDailyClose.documentId` / `RevenueSettlement.documentId` NULL).

**Schema change needed (proposed, NOT applied):**

```prisma
/// The original file of one revenue report upload (Z / settlement), as the owner uploaded it. One per run.
/// Not a Document: never in the inbox, OCR, documents export or the accountant package.
model RevenueReportFile {
  id               Int       @id @default(autoincrement())
  businessId       Int
  /// The commit's run (ImportRun z_report / settlement_report); the rows carry ingestRef "importrun:<id>".
  importRunId      Int       @unique
  kind             String    // "z" | "settlement"
  /// biz/{businessId}/revenue-reports/{kind}/{sha256}.{ext} — content-addressed, server-built.
  storageKey       String
  /// = ImportRun.contentHash (sha256 of the exact bytes).
  contentHash      String
  mimeType         String
  sizeBytes        Int
  /// Sanitised display name (≤ 200), never used to build the key.
  originalFileName String
  uploadedByUserId Int?
  /// STORED, or ERASED (object deleted; the row kept as the tombstone of what existed).
  state            String    @default("STORED")
  erasedAt         DateTime?
  createdAt        DateTime  @default(now())

  @@unique([businessId, id])
  @@index([businessId, storageKey])
}
 model ImportRun {
   …
+  @@unique([businessId, id])
 }
```

SQL: FK `(businessId, importRunId) → ImportRun(businessId, id)` (hence the composite unique on ImportRun — an index
only), FK `businessId → Business` ON DELETE RESTRICT, `uploadedByUserId → User` ON DELETE SET NULL; CHECKs (kind set,
state set, key prefix `'biz/' || businessId || '/revenue-reports/'`, `sizeBytes > 0`, `erasedAt IS NULL` ⇔ STORED);
FORCE RLS: tenant SELECT + INSERT, UPDATE only for the erasure path (`state`, `erasedAt`); runtime SELECT / INSERT
(+ UPDATE of those two columns); registered in `erasure-model-coverage.ts` and `erasure-object-surfaces.ts`.

* **Binding.** To the business: `businessId` + the key prefix + RLS + the storage metadata `businessId` (the read path
  checks all three). To the report record: `importRunId` (one file ↔ one run; every row recorded by that run has
  `ingestRef = importrun:<id>`, so row → run → file). A replay finds the run and its file; a re-decision of the same
  file is a new run whose row points at the same content-addressed object.
* **Download.** `GET /api/money/revenue-reports/runs/[runId]/file`: session (401), the kind's flag (404), the run looked
  up in the session business's tenant transaction (another business's id → 404), the bytes streamed by the server with
  `Content-Disposition: attachment`, the stored MIME, `private, no-store`, `X-Content-Type-Options: nosniff`. Who: the
  same users who may upload (the business's authenticated users, as for documents). Not in the accountant portal unless
  the owner decides so.
* **Commit atomicity / upload failure.** At commit, BEFORE the transaction: `putObject` to the content-addressed key
  (idempotent: same bytes, same key; a head check skips a re-upload). If it fails → the commit is refused
  (`FILE_STORE_FAILED`, 503, Hebrew "try again"), nothing recorded — keeping the original is part of the commit. Then
  the existing tenant transaction inserts the `RevenueReportFile` row together with the run and the rows: all or
  nothing. If the transaction fails after the object was written, the object is an orphan with no row: harmless
  (private, unreferenced) and reused by the retry; a sweep deletes `revenue-reports` objects with no row older than
  24 h. The analyze step stores nothing.
* **Separation.** Not a `Document`: never listed by the inbox, never queued for OCR (`/api/documents/[id]/process`
  reads `Document` only), never in the documents export, never in the accountant package (its builders read
  `Document` / `FinancialDocument` / `BillingDocument`, `lib/accountant/*`); a static test, added with the model, pins
  that none of those files names the model or the domain.
* **Deletion and erasure.** No owner delete and no purge job in stage one (retention is open). Account erasure: the
  model's disposition is **NEEDS_OWNER_DECISION** until retention is decided — either RETAINED (basis LEGAL/FISCAL: a
  Z report / settlement statement is bookkeeping evidence, kept like `Document.fileUrl`) or ERASED (object deleted
  first, then `state = ERASED`, like `CrmAttachment`). Either way the object surface is declared in
  `erasure-object-surfaces.ts` so the CI verifier tracks it.
* **Retention: NOT decided.** The design works for any period; nothing deletes anything until the owner decides.

## For the owner — decisions needed (none of these is done)

1. **D-9 — approve the original-file design** (new private storage domain `revenue-reports` + `RevenueReportFile` +
   `ImportRun @@unique([businessId, id])`), decide **retention**, and whether erasure RETAINS or ERASES these files.
2. **D-1 / D-11 / D-12 — approve the joint registers + standing sales-source model** (`RevenueRegister` +
   `RevenueSalesSource` + `RevenueRegisterSalesSource`), and who may change a standing decision. Until then: every Z
   upload asks (built), and a register whose sales are recorded another way cannot be uploaded.
3. **D-12 — approve the imported-history overlap reader** (the firewall entry + `historical-overlap-reader.ts` as on
   the branch), then a separate commit switches `IMPORTED_HISTORY_OVERLAP_ENABLED` to `true`. Also decide whether a
   history document on the Z's day should HOLD the Z (as now, per D-12) or only ASK (like the amount suspicion).
4. **D-4 — keep `<id>#c<n>`** (sufficient, proven above) or adopt the optional `revision` / `supersedesId` hardening.
5. **D-2 — keep the overlap test** (Z text on a same-day approved income document = HOLD; same amount alone = question),
   or persist the documents Z-guard answer (schema change) so a "record anyway" Z document is known for certain.
6. **Activation** — none of the above enables anything: the registry stays empty and both flags OFF until each source
   is verified on original samples; the migration of #918 is not applied.
