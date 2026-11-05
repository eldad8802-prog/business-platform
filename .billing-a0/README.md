# Billing A0 — characterization of the existing documents

Owner directive (2026-11-05): the existing billing mechanism is compliant and must
not change as part of the document-types expansion. A0 is the safety net that
proves it: tests and a CI report only. **No product code, no schema, no migration,
no Production access.**

## What is pinned, and how

| Area | Test | How it is compared |
| --- | --- | --- |
| Frozen snapshot + `legalSnapshotHash`, all 5 types (3 layouts, logo/visual signature, receipt with/without unapplied, partial credit, quote) | `golden.test.ts` | **Byte-exact**: canonical JSON of the snapshot built by `buildIssuedSnapshot` / `buildQuotePdfSnapshot`, and the hash from `hashIssuedSnapshot` |
| PDF — renderer input | `golden.test.ts` | **Byte-exact**: sha256 + length of the full HTML from `buildBillingInvoiceHtml` (Production renderer) and sha256 of the pdfmake document definition, per type, plus the allocation-number overlay |
| PDF — rendered output | `pdf-render.test.ts` | **Content, not bytes**: page count + full extracted text with whitespace removed, through both renderers. Excluded: `CreationDate`, `ModDate`, `Producer`, `Creator`, document `ID` |
| Numbering | `golden.test.ts`, `battery.mts` | Quote format (pure); real issuance: one sequence per type from 1, 6 digits, interleaving does not move other types, 6 parallel issues → unique contiguous numbers, sequence rows |
| Allocation numbers | `golden.test.ts`, `battery.mts` | Requirement table, eligible types, approval type codes, threshold at date boundaries, readiness matrix (300 cases), deliverability matrix, approval payload per type, 9-digit derivation. In the DB: which documents get a READY submission and that the approval executor is invoked exactly for them — through a **local stub** (`IssueAuthorityDeps`), never the tax authority |
| Uniform export (מבנה אחיד) | `golden.test.ts`, `battery.mts` | **Byte-exact** INI + BKMVDATA (fixed primary id / timestamp), loader query, assembler exclusions and warnings, report data; in the DB: which real rows the loader exports (quote and drafts excluded) |
| Immutability | `battery.mts` | Issued document refuses line edits and re-issue; a quote is never issued |

Why rendered PDFs are not compared byte for byte: every render embeds a new
creation date, and Production renders with the serverless Chromium build
(`@sparticuz/chromium`) while CI renders with the Playwright Chromium. The
byte-exact guarantee sits on the renderer's complete input instead.

## Baselines

`baseline/golden.json`, `baseline/pdf-render.json`, `baseline/db.json` — each file
stamps the source commit and runtime it was recorded from. They were recorded by
`record-baseline.mts --write --pdf` and `battery.mts --record` on **unmodified
code**: both recorders refuse when anything outside `.billing-a0/` is changed. No
test ever writes a baseline. A baseline is only ever added; rewriting one is
reported by the guard (G2) and needs the owner's approval.

Data is synthetic only (business 9001 in the pure tests; a fresh throwaway
business per run in the database battery).

## Running

```
npx tsx .billing-a0/golden.test.ts
npx playwright install chromium && npx tsx .billing-a0/pdf-render.test.ts
DATABASE_URL=<throwaway postgres> npx prisma db push --skip-generate && npx tsx .billing-a0/battery.mts
node scripts/ci/billing-protected-paths-guard.mjs --self-test
```

CI: `.github/workflows/billing-a0-characterization-ci.yml` (golden / render /
database, each with negative proofs that mutate the existing code in the ephemeral
checkout and must go red for the stated reason).

## Protected-paths guard

`scripts/ci/billing-protected-paths-guard.mjs`, run by
`.github/workflows/billing-protected-paths-guard.yml` on every pull request to
main. Reporting only: not a required check, no branch-protection change.

- G1 any change under: `lib/services/billing/`, `lib/billing/`, `app/api/billing/`,
  `app/billing/`, `components/billing/`, `lib/services/payments/`,
  `app/api/payments/`, `app/api/collection/`, `app/api/reports/uniform/`,
  `lib/services/financial-events/`, `lib/pdf/`
- G2 a modified / deleted / renamed file under `.billing-a0/baseline/`
- G3 `prisma/schema.prisma`: any change inside a model / enum whose name starts with
  `Billing`, or `FinancialEvent*`, `BusinessPaymentConnection`, `PaymentRequest*`,
  `PaymentTransaction*`, `PaymentProviderRouting`, `PaymentWebhookEvent*`,
  `PaymentAuditEvent`, `PaymentProvider`, `PaymentAccountingSettlement*`,
  `PaymentMethod`, `PaymentDocumentIssuer` (payables models are not included)
- G4 an added / modified `migration.sql` that mentions any of those names outside
  comments

## Existing defects seen while recording (documented, NOT fixed here)

- The PDF title of TAX_INVOICE_RECEIPT, RECEIPT and CREDIT_NOTE is the raw type
  name in English (both renderers) — pinned as it is.
- The pdfmake renderer does not print the allocation number (its document
  definition is identical with and without it). pdfmake is blocked in Production;
  the HTML renderer prints it.
