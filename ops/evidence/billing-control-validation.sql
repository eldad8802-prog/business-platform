-- Read-only Production CONTROL validation: confirm the connected database is a
-- populated Billing dataset (the denominator for the historical-evidence zero).
-- Grouped counts + min/max timestamps only. No ids, no names, no PII.
-- SELECT-only; READ ONLY transaction that rolls back; a static guard rejects any
-- write keyword before this file ever reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

-- C1 total billing documents.
SELECT 'C1_total_documents' AS q, count(*) AS n FROM "BillingDocument";

-- C2 by status.
SELECT 'C2_by_status' AS q, status AS status, count(*) AS n
FROM "BillingDocument" GROUP BY status ORDER BY status;

-- C3 by type.
SELECT 'C3_by_type' AS q, "documentType" AS dtype, count(*) AS n
FROM "BillingDocument" GROUP BY "documentType" ORDER BY "documentType";

-- C4 eligible-type totals (no other filter).
SELECT 'C4_eligible_total' AS q,
  count(*) FILTER (WHERE "documentType" = 'TAX_INVOICE') AS tax_invoice,
  count(*) FILTER (WHERE "documentType" = 'CREDIT_NOTE') AS credit_note
FROM "BillingDocument";

-- C5 total authority submissions.
SELECT 'C5_total_submissions' AS q, count(*) AS n
FROM "BillingAuthoritySubmission";

-- C6/C7 document createdAt span.
SELECT 'C6_C7_created_span' AS q,
  min("createdAt") AS earliest_created,
  max("createdAt") AS latest_created
FROM "BillingDocument";

-- C8/C9 issuedAt span (non-null only).
SELECT 'C8_C9_issued_span' AS q,
  min("issuedAt") AS earliest_issued,
  max("issuedAt") AS latest_issued
FROM "BillingDocument"
WHERE "issuedAt" IS NOT NULL;

ROLLBACK;
