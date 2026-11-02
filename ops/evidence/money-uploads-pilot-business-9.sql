-- ============================================================================
-- money-uploads-pilot-business-9.sql
--
-- Read-only Production measurement for the העלאת דוחות וקבצים pilot on the TEST business (businessId = 9):
-- bank file import (B1), documents, and import from another system. Run it twice — BEFORE the pilot (baseline)
-- and AFTER it — and compare: every pilot write must appear as a difference on business 9 only, and nothing may
-- move anywhere else.
--
-- Before the real bank file is imported, checks 20-24 answer one question: are that file's transactions already
-- held through the OLD statement upload? The file covers 2026-07-15 .. 2026-10-05 (the dates only; no amount,
-- description or reference of the file is in this repository). Lines of business 9 in that window, by path, are
-- counted; B1's own preview then classifies every line (new / already held / suspected) before anything is written.
--
-- OUTPUT (scripts/ci/evidence-redact.mjs): check number, counts and flags only. No id, name, amount, text or email.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== money uploads pilot, business 9: legend =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; row level security is off for this read)'
\echo ' 2 business 9 exists (flag)'
\echo '10 bank_file_import: the definition row exists (flag)'
\echo '11 bank_file_import: global policy enabled (flag; expected false)'
\echo '12 bank_file_import: business 9 override is ENABLED (flag)'
\echo '13 bank_file_import: overrides on ANY OTHER business (count; expected 0)'
\echo '14 business 9 active bank accounts (count; B1 needs one)'
\echo '20 business 9 bank lines, all sources (count)'
\echo '21 business 9 bank lines from the OLD statement upload, batch upl- (count)'
\echo '22 business 9 bank lines from bank file import, batch bnk- (count)'
\echo '23 of 21, lines dated 2026-07-15 .. 2026-10-05 — the real file window (count)'
\echo '24 of 23, uploaded with no bank account chosen (count; B1 shows these as suspected, never silently new)'
\echo '25 PLATFORM: bank file import lines on any business other than 9 (count; expected 0)'
\echo '30 business 9 import runs, bank_statement (count)'
\echo '31 business 9 import runs, tabular domains customers/suppliers/leads/inventory (count)'
\echo '32 business 9 import runs, historical-documents (count)'
\echo '33 business 9 import runs, documents (count)'
\echo '34 business 9 import runs FAILED or still EXECUTING (count)'
\echo '40 business 9 documents (count)'
\echo '41 business 9 documents needs_review / processing / failed (count)'
\echo '42 business 9 documents approved (count)'
\echo '43 business 9 documents with OCR text (count)'
\echo '44 business 9 documents uploaded in the last 2 days (count)'
\echo '45 business 9 documents uploaded in the last 2 days WITH OCR text (count; Google Vision ran)'
\echo '46 business 9 financial records, income (count)'
\echo '47 business 9 financial records, expense (count)'
\echo '48 business 9 financial records of documents uploaded in the last 2 days (count)'
\echo '50 business 9 accountant recipient configured (flag)'
\echo '51 business 9 accountant deliveries APPROVED or SENDING — a send in flight (count; expected 0)'
\echo '52 business 9 accountant deliveries, all (count)'
\echo '53 business 9 accountant periods marked changed (dirtyAt set) (count)'
\echo '54 business 9 accountant_delivery override is DISABLED (flag)'
\echo '60 business 9 customers (count)'
\echo '61 business 9 suppliers (count)'
\echo '62 business 9 leads (count)'
\echo '63 business 9 inventory items (count)'
\echo '64 business 9 historical fiscal documents (count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '25s';
-- Hard stop: a query that row level security would filter raises an ERROR instead of undercounting.
SET LOCAL row_security = off;

\echo '== visibility =='
SELECT 1 AS n, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS flag;
SELECT 2 AS n, EXISTS (SELECT 1 FROM "Business" WHERE "id" = 9) AS flag;

\echo '== bank file import switch =='
SELECT 10 AS n, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = 'bank_file_import') AS flag;
SELECT 11 AS n, COALESCE((SELECT "globalEnabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'bank_file_import'), false) AS flag;
SELECT 12 AS n, EXISTS (SELECT 1 FROM "BusinessFeatureAccess"
                         WHERE "businessId" = 9 AND "featureKey" = 'bank_file_import' AND "state"::text = 'ENABLED') AS flag;
SELECT 13 AS n, count(*) AS count FROM "BusinessFeatureAccess"
 WHERE "featureKey" = 'bank_file_import' AND "businessId" <> 9;
SELECT 14 AS n, count(*) AS count FROM "BusinessBankAccount" WHERE "businessId" = 9 AND "isActive";

\echo '== bank lines =='
SELECT 20 AS n, count(*) AS count FROM "ExternalTransaction" WHERE "businessId" = 9;
SELECT 21 AS n, count(*) AS count FROM "ExternalTransaction"
 WHERE "businessId" = 9 AND "source"::text = 'OWNER_UPLOAD' AND "importBatchId" LIKE 'upl-%';
SELECT 22 AS n, count(*) AS count FROM "ExternalTransaction"
 WHERE "businessId" = 9 AND "importBatchId" LIKE 'bnk-%';
SELECT 23 AS n, count(*) AS count FROM "ExternalTransaction"
 WHERE "businessId" = 9 AND "source"::text = 'OWNER_UPLOAD' AND "importBatchId" LIKE 'upl-%'
   AND "bookedAt" >= DATE '2026-07-15' AND "bookedAt" < DATE '2026-10-06';
SELECT 24 AS n, count(*) AS count FROM "ExternalTransaction"
 WHERE "businessId" = 9 AND "source"::text = 'OWNER_UPLOAD' AND "importBatchId" LIKE 'upl-%'
   AND "bookedAt" >= DATE '2026-07-15' AND "bookedAt" < DATE '2026-10-06'
   AND "sourceBankAccountId" IS NULL;
SELECT 25 AS n, count(*) AS count FROM "ExternalTransaction"
 WHERE "businessId" <> 9 AND "importBatchId" LIKE 'bnk-%';

\echo '== import runs =='
SELECT 30 AS n, count(*) AS count FROM "ImportRun" WHERE "businessId" = 9 AND "domain" = 'bank_statement';
SELECT 31 AS n, count(*) AS count FROM "ImportRun"
 WHERE "businessId" = 9 AND "domain" IN ('customers', 'suppliers', 'leads', 'inventory');
SELECT 32 AS n, count(*) AS count FROM "ImportRun" WHERE "businessId" = 9 AND "domain" = 'historical-documents';
SELECT 33 AS n, count(*) AS count FROM "ImportRun" WHERE "businessId" = 9 AND "domain" = 'documents';
SELECT 34 AS n, count(*) AS count FROM "ImportRun"
 WHERE "businessId" = 9 AND "status"::text IN ('FAILED', 'EXECUTING');

\echo '== documents and financial records =='
SELECT 40 AS n, count(*) AS count FROM "Document" WHERE "businessId" = 9;
SELECT 41 AS n, count(*) AS count FROM "Document"
 WHERE "businessId" = 9 AND "status" IN ('needs_review', 'processing', 'failed');
SELECT 42 AS n, count(*) AS count FROM "Document" WHERE "businessId" = 9 AND "status" = 'approved';
SELECT 43 AS n, count(*) AS count FROM "Document"
 WHERE "businessId" = 9 AND length(btrim(COALESCE("ocrText", ''))) > 0;
SELECT 44 AS n, count(*) AS count FROM "Document"
 WHERE "businessId" = 9 AND "createdAt" > now() - interval '2 days';
SELECT 45 AS n, count(*) AS count FROM "Document"
 WHERE "businessId" = 9 AND "createdAt" > now() - interval '2 days'
   AND length(btrim(COALESCE("ocrText", ''))) > 0;
SELECT 46 AS n, count(*) AS count FROM "FinancialRecord" WHERE "businessId" = 9 AND "direction" = 'income';
SELECT 47 AS n, count(*) AS count FROM "FinancialRecord" WHERE "businessId" = 9 AND "direction" = 'expense';
SELECT 48 AS n, count(*) AS count FROM "FinancialRecord" f JOIN "Document" d ON d."id" = f."documentId"
 WHERE f."businessId" = 9 AND d."createdAt" > now() - interval '2 days';

\echo '== accountant: nothing can be sent =='
SELECT 50 AS n, EXISTS (SELECT 1 FROM "AccountantRecipient" WHERE "businessId" = 9) AS flag;
SELECT 51 AS n, count(*) AS count FROM "AccountantDelivery"
 WHERE "businessId" = 9 AND "status" IN ('APPROVED', 'SENDING');
SELECT 52 AS n, count(*) AS count FROM "AccountantDelivery" WHERE "businessId" = 9;
SELECT 53 AS n, count(*) AS count FROM "AccountantPeriod" WHERE "businessId" = 9 AND "dirtyAt" IS NOT NULL;
SELECT 54 AS n, EXISTS (SELECT 1 FROM "BusinessFeatureAccess"
                         WHERE "businessId" = 9 AND "featureKey" = 'accountant_delivery' AND "state"::text = 'DISABLED') AS flag;

\echo '== imported records =='
SELECT 60 AS n, count(*) AS count FROM "Customer" WHERE "businessId" = 9;
SELECT 61 AS n, count(*) AS count FROM "Supplier" WHERE "businessId" = 9;
SELECT 62 AS n, count(*) AS count FROM "Lead" WHERE "businessId" = 9;
SELECT 63 AS n, count(*) AS count FROM "InventoryItem" WHERE "businessId" = 9;
SELECT 64 AS n, count(*) AS count FROM "HistoricalFiscalDocument" WHERE "businessId" = 9;

ROLLBACK;
