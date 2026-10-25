-- ============================================================================
-- accountant-g2-business-9-details.sql
--
-- Read-only Production details of the first monthly accountant package (G2.2, business 9,
-- September 2026), for the owner's report: the period's exact status, the package's version and
-- contents (records, files placed, files missing, open items), that the stored object was sealed
-- (size + sha256 recorded), and the owner's notice (which kind, in-app only, never pushed).
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, amount or text.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant G2.2 details for business 9, September 2026: legend =='
\echo ' 1 the period status is READY_FOR_REVIEW (flag)'
\echo ' 2 the period status is NEEDS_ATTENTION (flag)'
\echo ' 3 package version (count)'
\echo ' 4 financial records in the package (count)'
\echo ' 5 original files placed in the package (count)'
\echo ' 6 files missing from storage (count)'
\echo ' 7 documents still waiting for review, listed in the package (count)'
\echo ' 8 issued billing documents in the package (count)'
\echo ' 9 open items on the package (count)'
\echo '10 the stored object is sealed: size above zero and a sha256 recorded (flag)'
\echo '11 package size in KB (count)'
\echo '12 the live notice says the file is ready (flag)'
\echo '13 the live notice says the file is not complete yet (flag)'
\echo '14 in-app deliveries of that notice (count)'
\echo '15 push deliveries of that notice (count; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
per AS (SELECT p.* FROM "AccountantPeriod" p WHERE p."businessId" = 9 AND p."periodKey" = '2026-09'),
pkg AS (SELECT k.* FROM "AccountantPackage" k JOIN per ON per."id" = k."periodId" WHERE k.status = 'READY'),
note AS (SELECT x.* FROM "Notification" x WHERE x."businessId" = 9 AND x."entityType" LIKE 'accountant\_period%' AND x."resolvedAt" IS NULL),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT bool_and(status = 'READY_FOR_REVIEW') FROM per), NULL::bigint
  UNION ALL SELECT 2, (SELECT bool_and(status = 'NEEDS_ATTENTION') FROM per), NULL
  UNION ALL SELECT 3, NULL, (SELECT max(version) FROM pkg)
  UNION ALL SELECT 4, NULL, (SELECT max((manifest->>'recordCount')::bigint) FROM pkg)
  UNION ALL SELECT 5, NULL, (SELECT max((manifest->>'approvedFiles')::bigint) FROM pkg)
  UNION ALL SELECT 6, NULL, (SELECT max((manifest->>'missingFiles')::bigint) FROM pkg)
  UNION ALL SELECT 7, NULL, (SELECT max((manifest->>'pendingCount')::bigint) FROM pkg)
  UNION ALL SELECT 8, NULL, (SELECT max((manifest->>'issuedCount')::bigint) FROM pkg)
  UNION ALL SELECT 9, NULL, (SELECT max("openItemCount") FROM pkg)
  UNION ALL SELECT 10, (SELECT bool_and("sizeBytes" > 0 AND "sha256" IS NOT NULL AND length("sha256") = 64) FROM pkg), NULL
  UNION ALL SELECT 11, NULL, (SELECT max("sizeBytes") / 1024 FROM pkg)
  UNION ALL SELECT 12, (SELECT bool_or("entityType" = 'accountant_period_ready') FROM note), NULL
  UNION ALL SELECT 13, (SELECT bool_or("entityType" = 'accountant_period_attention') FROM note), NULL
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "NotificationDelivery" d JOIN note ON note."id" = d."notificationId" WHERE d.channel::text = 'IN_APP')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "NotificationDelivery" d JOIN note ON note."id" = d."notificationId" WHERE d.channel::text = 'PUSH')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
