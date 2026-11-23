-- ============================================================================
-- storage-erasure-sweep-evidence.sql
--
-- Read-only Production evidence for the shared account storage-erasure sweep (/api/account/storage-erasure-sweep,
-- scheduled hourly by #1239, switched on by ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED, owner decision 2026-11-23).
-- Flags and counts only:
--   A. 1-3   who the sweep may reach: businesses with a deletion requested / completed;
--   B. 4-9   the erasure jobs of both modules exist only for businesses whose deletion was requested (the purge
--            transaction opens them), by state;
--   C. 10-12 nothing of a live business is touched: no FENCED business document file and no erasure job outside a
--            business being or already deleted;
--   D. 13-15 the sweep is working: Service Desk jobs passed in the last 2 hours, the newest pass age in minutes,
--            jobs whose last pass recorded an error code.
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids, no keys.
-- ============================================================================

\echo '== storage erasure sweep evidence: legend (n -> check) =='
\echo ' 1 businesses with a deletion requested (count; info)'
\echo ' 2 businesses deleted (count; info)'
\echo ' 3 businesses with a deletion requested but not yet deleted (count; info: no job, nothing of them is touched)'
\echo ' 4 business documents erasure jobs PURGING_OBJECTS (count; info)'
\echo ' 5 business documents erasure jobs DONE (count; info)'
\echo ' 6 Service Desk storage erasure jobs PENDING_OBJECTS (count; info)'
\echo ' 7 Service Desk storage erasure jobs DONE (count; info)'
\echo ' 8 business documents jobs of a business with no deletion requested (count; expected 0)'
\echo ' 9 Service Desk jobs of a business with no deletion requested (count; expected 0)'
\echo '10 FENCED business document files of a business with no business documents erasure job (count; expected 0)'
\echo '11 FENCED business document files of a live business (no deletion requested) (count; expected 0)'
\echo '12 business document files of live businesses (count; info: untouched)'
\echo '13 Service Desk jobs passed in the last 2 hours (count; info: > 0 once the sweep runs and a job is open)'
\echo '14 minutes since the newest Service Desk pass (count; info, -1 = no job ever passed)'
\echo '15 Service Desk jobs whose last pass recorded an error code (count; expected 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
req AS (SELECT b."id" FROM "Business" b WHERE b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL),
live AS (SELECT b."id" FROM "Business" b WHERE b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM "Business" WHERE "deletionRequestedAt" IS NOT NULL)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "Business" WHERE "deletedAt" IS NOT NULL)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "Business" WHERE "deletionRequestedAt" IS NOT NULL AND "deletedAt" IS NULL)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "BusinessDocumentErasure" WHERE "state"::text = 'PURGING_OBJECTS')
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "BusinessDocumentErasure" WHERE "state"::text = 'DONE')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "ServiceStorageErasure" WHERE "state"::text = 'PENDING_OBJECTS')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "ServiceStorageErasure" WHERE "state"::text = 'DONE')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "BusinessDocumentErasure" j WHERE j."businessId" NOT IN (SELECT "id" FROM req))
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "ServiceStorageErasure" j WHERE j."businessId" NOT IN (SELECT "id" FROM req))
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "BusinessDocumentFile" f WHERE f."state"::text = 'FENCED'
                                AND NOT EXISTS (SELECT 1 FROM "BusinessDocumentErasure" j WHERE j."businessId" = f."businessId"))
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BusinessDocumentFile" f WHERE f."state"::text = 'FENCED' AND f."businessId" IN (SELECT "id" FROM live))
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "BusinessDocumentFile" f WHERE f."businessId" IN (SELECT "id" FROM live))
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "ServiceStorageErasure" WHERE "lastPassAt" >= now() - INTERVAL '2 hours')
  UNION ALL SELECT 14, NULL, (SELECT COALESCE(floor(extract(epoch FROM (now() - max("lastPassAt"))) / 60)::bigint, -1) FROM "ServiceStorageErasure")
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "ServiceStorageErasure" WHERE "lastError" IS NOT NULL)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
