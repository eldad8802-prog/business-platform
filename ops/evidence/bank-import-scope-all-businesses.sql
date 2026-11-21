-- ============================================================================
-- bank-import-scope-all-businesses.sql
--
-- Read-only Production scope check for bank file import (B1, feature bank_file_import) across ALL businesses,
-- before the foreign-currency and target-account guards are reviewed. It answers:
--   * where is B1 open? (expected: an ENABLED override on business 9 only; the global policy OFF);
--   * which businesses have bank statement import runs, and bank lines by path
--     (old statement upload batch upl-, bank file import batch bnk-, other sources);
--   * is any bank line recorded in a currency other than ILS? (expected 0: B1 never writes one);
--   * how many bank accounts each business holds (several accounts = where a wrong-account upload can happen).
--
-- OUTPUT (scripts/ci/evidence-redact.mjs): check number, business ids (column business_n), counts and
-- PASS / FAIL flags only. No name, email, amount, description, reference, label or account number.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== bank file import scope, all businesses: legend =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; row level security is off for this read)'
\echo '10 bank_file_import: the definition row exists (flag)'
\echo '11 bank_file_import: definition defaultEnabled (flag; expected false)'
\echo '12 bank_file_import: global policy enabled (flag; expected false)'
\echo '13 bank_file_import: emergency switch on (flag; expected false)'
\echo '14 bank_file_import overrides per business: enabled_count / disabled_count (rows; expected one row, business 9 ENABLED)'
\echo '15 businesses with an ENABLED override other than business 9 (result PASS when 0)'
\echo '20 bank_statement import runs per business: runs_count, completed_count, failed_or_open_count'
\echo '21 bank lines per business by path: upl_count (old upload), upl_no_account_count, bnk_count (B1), other_upload_count, entry_count, feed_count, provider_count, total_count'
\echo '22 bank lines from B1 (bnk-) on any business other than 9 (result PASS when 0)'
\echo '23 bank lines with a currency other than ILS, per business: non_ils_count (expected no rows)'
\echo '24 bank lines with a currency other than ILS, all businesses (result PASS when 0)'
\echo '25 bank accounts per business: active_count, archived_count'
\echo '26 businesses holding more than one active bank account (count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '25s';
-- Hard stop: a query that row level security would filter raises an ERROR instead of undercounting.
SET LOCAL row_security = off;

\echo '== visibility =='
SELECT 1 AS n, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS flag;

\echo '== the switch =='
SELECT 10 AS n, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = 'bank_file_import') AS flag;
SELECT 11 AS n, COALESCE((SELECT "defaultEnabled" FROM "PlatformFeatureDefinition" WHERE "key" = 'bank_file_import'), false) AS flag;
SELECT 12 AS n, COALESCE((SELECT "globalEnabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'bank_file_import'), false) AS flag;
SELECT 13 AS n, COALESCE((SELECT "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'bank_file_import'), false) AS flag;

SELECT 14 AS n, "businessId" AS business_n,
       count(*) FILTER (WHERE "state"::text = 'ENABLED') AS enabled_count,
       count(*) FILTER (WHERE "state"::text = 'DISABLED') AS disabled_count
  FROM "BusinessFeatureAccess"
 WHERE "featureKey" = 'bank_file_import'
 GROUP BY "businessId"
 ORDER BY "businessId";

SELECT 15 AS n,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS observed_count
  FROM "BusinessFeatureAccess"
 WHERE "featureKey" = 'bank_file_import' AND "state"::text = 'ENABLED' AND "businessId" <> 9;

\echo '== import runs =='
SELECT 20 AS n, "businessId" AS business_n,
       count(*) AS runs_count,
       count(*) FILTER (WHERE "status"::text = 'COMPLETED') AS completed_count,
       count(*) FILTER (WHERE "status"::text <> 'COMPLETED') AS failed_or_open_count
  FROM "ImportRun"
 WHERE "domain" = 'bank_statement'
 GROUP BY "businessId"
 ORDER BY "businessId";

\echo '== bank lines by path =='
SELECT 21 AS n, "businessId" AS business_n,
       count(*) FILTER (WHERE "source"::text = 'OWNER_UPLOAD' AND "importBatchId" LIKE 'upl-%') AS upl_count,
       count(*) FILTER (WHERE "source"::text = 'OWNER_UPLOAD' AND "importBatchId" LIKE 'upl-%'
                          AND "sourceBankAccountId" IS NULL) AS upl_no_account_count,
       count(*) FILTER (WHERE "importBatchId" LIKE 'bnk-%') AS bnk_count,
       count(*) FILTER (WHERE "source"::text = 'OWNER_UPLOAD'
                          AND COALESCE("importBatchId", '') NOT LIKE 'upl-%'
                          AND COALESCE("importBatchId", '') NOT LIKE 'bnk-%') AS other_upload_count,
       count(*) FILTER (WHERE "source"::text = 'OWNER_ENTRY') AS entry_count,
       count(*) FILTER (WHERE "source"::text = 'BANK_FEED') AS feed_count,
       count(*) FILTER (WHERE "source"::text = 'PROVIDER') AS provider_count,
       count(*) AS total_count
  FROM "ExternalTransaction"
 GROUP BY "businessId"
 ORDER BY "businessId";

SELECT 22 AS n,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS observed_count
  FROM "ExternalTransaction"
 WHERE "importBatchId" LIKE 'bnk-%' AND "businessId" <> 9;

\echo '== currency =='
SELECT 23 AS n, "businessId" AS business_n, count(*) AS non_ils_count
  FROM "ExternalTransaction"
 WHERE "currency" IS DISTINCT FROM 'ILS'
 GROUP BY "businessId"
 ORDER BY "businessId";

SELECT 24 AS n,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) AS observed_count
  FROM "ExternalTransaction"
 WHERE "currency" IS DISTINCT FROM 'ILS';

\echo '== bank accounts =='
SELECT 25 AS n, "businessId" AS business_n,
       count(*) FILTER (WHERE "isActive") AS active_count,
       count(*) FILTER (WHERE NOT "isActive") AS archived_count
  FROM "BusinessBankAccount"
 GROUP BY "businessId"
 ORDER BY "businessId";

SELECT 26 AS n, count(*) AS count
  FROM (SELECT "businessId" FROM "BusinessBankAccount" WHERE "isActive" GROUP BY "businessId" HAVING count(*) > 1) x;

ROLLBACK;
