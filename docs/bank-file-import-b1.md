# Bank file import — revenue truth milestone B1

Owner-approved scope (2026-10-25): a second way to upload a bank statement (CSV or XLSX), with a full preview
before anything is written, into the **existing** `ExternalTransaction` rows. Behind `bank_file_import`, OFF.
No open banking, no bank API: the owner uploads the file their bank exports.

## What it is

| Piece | Where |
|---|---|
| Pure core: header search, mapping, cells → lines, balance chain, identities | `lib/services/bank-file-import/bank-file-core.ts` |
| Analyze (zero writes) and commit (one transaction) | `lib/services/bank-file-import/bank-file-import.service.ts` |
| HTTP edge: session business, flag OFF ⇒ 404 | `lib/services/bank-file-import/http.ts`, `app/api/payables/bank-import/**` |
| Screen (Hebrew only) | `app/(shell)/payables/bank/import/page.tsx` |
| Flag | `bank_file_import` in `platform-feature-catalog.ts`; its rows ship in migration `20261029090000_bank_file_import_feature` (separate PR) |

Reused as is: the data-transfer readers (`readImportSource`: CSV in UTF-8 / UTF-16 / windows-1255, XLSX, size
and row limits), the signed envelope, `retryKeyOf`, the payables parsers (`parseStatementDate`,
`parseStatementAmount`), `statementLineIdentities`, `writeAudit`, `ImportRun`. Not touched: the payables upload
(`uploadStatement`, its route and screen), documents, `FinancialRecord`, `FinancialEvent`, reports, the accountant
package, payments, the account deletion process.

What is written on commit: the new lines (`ExternalTransaction`, source `OWNER_UPLOAD`, the chosen account,
value date when mapped, `importBatchId = bnk-<runId>`), one `ImportRun` (domain `bank_statement`, the file's
sha-256, counts; the file itself is not kept), one `PayablesAuditEvent`. Nothing else.

## One line, one row — the identity

The payables upload gives a line the identity `statementLineIdentities(business, account | "-", line)` over
what `parseStatementCsv` read. This path writes the same table and source, so it must give the same identity:

- the identity fields (date, amount or debit / credit, description, reference) are locked to the columns
  `parseStatementCsv` would pick (`legacyColumns`, its aliases and header normalization verbatim), and read with
  its own date / amount parsers; unreadable lines are skipped as there, so the occurrence counter among
  identical lines matches;
- only value date, balance and counterparty are freely mapped (none is part of the identity), and files the old
  parser cannot read at all;
- **parity is tested** (`bank-file-core.test.ts`): on the same CSV files, `parseStatementCsv` and this path give
  the same lines, the same skipped rows and the same identities, with and without an account;
- every line is checked under **both** identities — with the chosen account and with none — before insert;
- the insert is `ON CONFLICT DO NOTHING` on `(businessId, source, externalId)`;
- commits for one business serialise on `pg_advisory_xact_lock(hashtext('bank-lines-ingest:<businessId>'))`.

Accepted divergence (files the old path mangles or refuses anyway): a space before an opening quote, a quoted
field spanning lines, a non-comma delimiter, a header below other lines, a non-UTF-8 file the browser reads as
UTF-8. Row numbers count non-empty rows, as the old parser does.

## Duplicates across the two paths — proven (.bfi/battery.ts, NOBYPASSRLS runtime)

| Order | Result |
|---|---|
| old path without an account → this path | 0 new (the "no account" identity is checked) |
| old path with the account → this path | 0 new |
| this path → old path with the same account | 0 new (same identity, unique key) |
| this path → old path **without** an account | **duplicates** — see below |
| same file again; same file, other mapping; CSV then the Excel of it | 0 new |
| overlapping statements (days 1–10, then 5–15) | only days 11–15 |
| identical charges (2, then a statement with 3) | 2, then 1 |
| same file committed 4× concurrently; two overlapping files concurrently; old path + this path concurrently | exact union, no line twice |

### The one remaining direction, and the proposed change (NOT in this PR)

The old path checks only its own identity. A file imported here (always with an account) and then uploaded on
the bank lines screen **without** choosing an account is written again. Closing it needs a change to the old
path, which is outside the approved scope; it is prepared for a separate decision:

- `uploadStatement` takes the same `bank-lines-ingest` lock and, before inserting, looks each line up under every
  identity it can have: without an account → under "no account" and under each of the business's accounts; with
  an account → also under "no account". Lines found are skipped. `ingestObservations` is split so the insert
  runs inside that transaction. Return shape, route and screen unchanged. ~50 lines in
  `payables-observation.service.ts`.
- Behaviour change for the old path alone: a statement uploaded once with and once without an account no longer
  duplicates (today it does).
- Proof run locally: `.bfi/battery.ts` 42/42 (the gap closed) and the existing old-path suite
  `payables-p46.db.test.ts` 77/77, on the branch with the change; the same suite 77/77 without it.
- Until it is approved: do not open `bank_file_import` for a business, or open it only together with the change.

## Retention and erasure — proposal only (no change to the deletion process in B1)

Today `ExternalTransaction`, `BusinessBankAccount` and `ExternalTransactionMatchRejection` are `unmanaged` in
`scripts/ci/erasure/erasure-model-coverage.ts` (account deletion neither keeps them by decision nor removes them);
`ImportRun` is `decide`. Proposed classification, for a separate approval, and not a legal determination:

| Data | Proposed | Needs a professional decision |
|---|---|---|
| `ExternalTransaction` | retained while it is evidence (a live `PaymentEvidence`, a confirmed `RevenueLink`); full export to the owner before deletion; the rest: delete only after the decision. Anonymising is not possible (the facts trigger freezes the text). | whether an uploaded bank line is a record Dubiz must keep after account deletion, and who must keep it |
| `BusinessBankAccount` | clear the encrypted coordinates and the note; keep id, label, last four. The row cannot be deleted while lines reference it (ON DELETE SET NULL is refused by the facts trigger — read from the code, not run). | no |
| uploaded files | not stored by B1 (hash + run summary only) | no |
| `ImportRun` / `ImportRunRow` / match-rejection note | run summary kept as audit; row markers deleted; the free-text note cleared | no |

## Real-file validation — what is needed and how to send it safely

Synthetic files prove the logic; only a real export proves a bank's layout. Before the flag is opened for any
business, per bank to be supported:

- one export as the bank produces it (CSV or Excel), **one or two days**, containing at least one credit and one
  debit, with the balance column if the bank has one;
- mask in a spreadsheet editor, without changing anything else: names, account numbers, descriptions and
  references → `XXX`; keep the header row, the column order, date and amount formats, the encoding (save as the
  same type), and any lines above the header;
- do not send it to GitHub, Production or any shared environment; it is used locally to add the layout to the
  synthetic generator, then deleted.

What only a real file can confirm: the bank's header labels, lines above the header, how credit and debit are
marked, date and number formats, encodings, summary rows at the end, whether an "XLS" is really HTML (not
supported in B1: the owner saves it as XLSX or CSV).

## Before merge / migration / activation

1. Merge the migration PR, then apply it with `release-migrate` (owner approval of `production-db`); evidence
   `ops/evidence/bank-file-import-feature-production-evidence.sql` (7 checks: OFF, nothing imported).
2. Merge this PR (code is inert while the flag is OFF; the screen answers "not open").
3. Decide the old-path change (above), and real-file validation per bank.
4. Only then a per-business override for a pilot business; the screen has no navigation entry in B1 (reached at
   `/payables/bank/import`) — where it appears is part of the activation decision.
