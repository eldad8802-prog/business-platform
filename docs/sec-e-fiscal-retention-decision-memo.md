# SEC-E — Owner decision memo: blanket retention of document evidence on account deletion

Status: **DECISION REQUIRED (owner / legal).** Nothing in this memo changes behaviour. The erasure
still retains all four models below exactly as before (`account-erasure-manifest.ts` `RETAIN_MODELS`,
`erasure-model-coverage.ts` `RETAINED_BY_DESIGN`). Workstream E has not narrowed retention, because
retention is a legal-policy decision (program brief, stop gates).

## 1. What is retained today, and on what basis

| Model | Registry basis | What survives an account deletion |
|---|---|---|
| `Document` | LEGAL/FISCAL | every row, whatever it is: `fileUrl` (the stored object is also kept, S8 `RETAINED`), `ocrText` (full OCR text), `originalFilename`, `source`, hash |
| `ExtractedData` | LEGAL/FISCAL | `vendorName`, `amount`, `date`, `category`, `direction` for every document with an extraction |
| `EmailAttachmentImport` | **UNPROVEN** | `fromEmail`, `subject`, `filename`, `threadId`, `messageId`, `error` — for every imported attachment, including ones that never became a document (`documentId` null) |
| `WhatsAppAttachmentImport` | **UNPROVEN** | `fromPhone` (raw phone number), `phoneNumberId`, `wamid`, `filename`, `error` — same, including rows with `documentId` null |

The retention is **blanket**: it is applied per model, not per row. A photo that failed OCR, an
image that was never a receipt, or a WhatsApp attachment rejected by validation is kept for the
statutory period on the same basis as a supplier invoice that was booked.

## 2. Which rows actually have a fiscal link

A `Document` row is **fiscally linked** when at least one of these points at it (schema relations,
current main):

- `FinancialRecord.documentId` (the extracted fiscal facts that were booked);
- `HistoricalFiscalDocument.documentId` (an imported historical fiscal record);
- `PaymentEvidence` (payables evidence) or `PayablesMatchRejection` citing the document.

`ExtractedData` alone is **not** a fiscal link: it is the extractor's output, written for every
processed upload whether or not anything was booked.

An import row (`EmailAttachmentImport` / `WhatsAppAttachmentImport`) inherits the link of its
`documentId`; a row with `documentId = null` (skipped, failed, duplicate, rejected) has none.

Read-only query the owner can run against a **copy** or with the read-only evidence workflow (not run
by this workstream; no production access was used):

```sql
WITH linked AS (
  SELECT d.id FROM "Document" d
  WHERE EXISTS (SELECT 1 FROM "FinancialRecord" f WHERE f."documentId" = d.id)
     OR EXISTS (SELECT 1 FROM "HistoricalFiscalDocument" h WHERE h."documentId" = d.id)
     OR EXISTS (SELECT 1 FROM "PaymentEvidence" p WHERE p."documentId" = d.id)
     OR EXISTS (SELECT 1 FROM "PayablesMatchRejection" r WHERE r."documentId" = d.id)
)
SELECT
  (SELECT count(*) FROM "Document")                                              AS documents,
  (SELECT count(*) FROM linked)                                                  AS documents_fiscally_linked,
  (SELECT count(*) FROM "EmailAttachmentImport" WHERE "documentId" IS NULL)      AS email_imports_without_document,
  (SELECT count(*) FROM "WhatsAppAttachmentImport" WHERE "documentId" IS NULL)   AS wa_imports_without_document,
  (SELECT count(*) FROM "EmailAttachmentImport" e WHERE e."documentId" NOT IN (SELECT id FROM linked)) AS email_imports_unlinked_document;
```

(Column names verified against `prisma/schema.prisma` on current main: `FinancialRecord.documentId`,
`HistoricalFiscalDocument.documentId`, `PaymentEvidence.documentId`, `PayablesMatchRejection.documentId`.)

## 3. The conservative narrowing (proposed, NOT implemented)

Each option is independent; each keeps every fiscally linked record intact.

1. **Import provenance minimisation (lowest risk).** On erasure, clear `EmailAttachmentImport.fromEmail`,
   `.subject`, `.threadId`, `.error` and `WhatsAppAttachmentImport.fromPhone`, `.error` on ALL rows. The
   dedupe keys (`contentHashSha256`, `(messageId, attachmentId)`, `wamid`) and `documentId` stay, so the
   evidence chain to the document is unaffected. Basis is currently `UNPROVEN`; no bookkeeping rule
   identified requires the sender's address or phone to be kept once the document itself is kept.
2. **Unlinked import rows (`documentId` null).** Delete them. They reference no document and no fiscal
   record; they are import bookkeeping only.
3. **Unlinked documents.** For a `Document` with no fiscal link (§2), delete the stored object and
   the row (with its `ExtractedData`), or at minimum clear `ocrText` and `originalFilename`. This is the
   one option that needs the legal owner: an uploaded document may be evidence even if it was never
   booked in Dubiz (the owner may have booked it elsewhere).

## 4. Questions for the owner (exact)

- Q1. May sender identity on import rows (`fromEmail`, `subject`, `fromPhone`) be erased on account
  deletion while the linked document is retained? (Option 1)
- Q2. May import rows that never produced a document be deleted on account deletion? (Option 2)
- Q3. Is a document with no fiscal link in Dubiz (no FinancialRecord / historical record / payables
  evidence) required to be retained? If not, is deletion or text minimisation preferred? (Option 3)
- Q4. Does the retention of `Document.ocrText` for fiscally linked documents need the full text, or is
  the stored original file sufficient evidence?

A "yes" to any of Q1–Q3 is implementable in the existing erasure (new stage inside the purge, contract
entries, AD-2A/SEC-E assertions); it was not done here because it changes a retention decision.
