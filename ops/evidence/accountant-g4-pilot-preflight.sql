-- ============================================================================
-- accountant-g4-pilot-preflight.sql
--
-- Read-only Production evidence immediately before the FIRST accountant send (G4 pilot): business 9,
-- September 2026, the recipient the owner saved in the screen. Run before the sending switch is turned on
-- and again right before the owner's own send.
--
--   * the recipient of business 9 exists, is version 1 (set once, never changed) and its address is the one
--     the owner chose — compared by sha256 of the normalised address, so the address itself is in neither
--     this file nor the output;
--   * the September package: READY_FOR_REVIEW, one READY package, version 1, 5 records, 5 original files,
--     0 missing, 0 pending, 0 issued, 0 open items, sealed;
--   * nothing was approved or sent anywhere yet: 0 deliveries, 0 approval / send / link events;
--   * the feature is on for business 9 only, and no other business has accountant rows.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs). Guard-clean: no write keyword anywhere, prose
-- included. Nothing is changed.
--
-- OUTPUT: n | flag | observed_count.
-- ============================================================================

\echo '== accountant G4 pilot preflight (business 9, 2026-09): legend =='
\echo ' 1 business 9 has exactly one recipient row (flag)'
\echo ' 2 its address is the chosen one (sha256 of the normalised address matches) (flag)'
\echo ' 3 recipient version (count; expected 1)'
\echo ' 4 recipients of any OTHER business (count; expected 0)'
\echo ' 5 the September period is READY_FOR_REVIEW (flag)'
\echo ' 6 READY packages for it (count; expected 1)'
\echo ' 7 package version (count; expected 1)'
\echo ' 8 records in the package (count; expected 5)'
\echo ' 9 original files in the package (count; expected 5)'
\echo '10 files missing from the package (count; expected 0)'
\echo '11 open items on the package (count; expected 0)'
\echo '12 the package is sealed: size above zero and a sha256 recorded (flag)'
\echo '13 deliveries, all businesses (count; expected 0)'
\echo '14 approval / send / link events, all businesses (count; expected 0)'
\echo '15 accountant_month_close overrides: exactly one, business 9 ENABLED (flag)'
\echo '16 accountant rows of any OTHER business: periods + packages + deliveries + trail (count; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
rcp AS (SELECT r.* FROM "AccountantRecipient" r WHERE r."businessId" = 9),
per AS (SELECT p.* FROM "AccountantPeriod" p WHERE p."businessId" = 9 AND p."periodKey" = '2026-09'),
pkg AS (SELECT k.* FROM "AccountantPackage" k JOIN per ON per."id" = k."periodId" WHERE k.status = 'READY'),
ovr AS (SELECT a.* FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'accountant_month_close'),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT count(*) = 1 FROM rcp), NULL::bigint
  UNION ALL SELECT 2, (SELECT bool_and(encode(sha256(convert_to(lower(btrim("email")), 'UTF8')), 'hex')
                                       = '92d7e928efff9443ce4d61b19aca3e69a0ee4cf34eb5361ddc29b80756defab5') FROM rcp), NULL
  UNION ALL SELECT 3, NULL, (SELECT max("version") FROM rcp)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" <> 9)
  UNION ALL SELECT 5, (SELECT bool_and(status = 'READY_FOR_REVIEW') FROM per), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM pkg)
  UNION ALL SELECT 7, NULL, (SELECT max(version) FROM pkg)
  UNION ALL SELECT 8, NULL, (SELECT max((manifest->>'recordCount')::bigint) FROM pkg)
  UNION ALL SELECT 9, NULL, (SELECT max((manifest->>'approvedFiles')::bigint) FROM pkg)
  UNION ALL SELECT 10, NULL, (SELECT max((manifest->>'missingFiles')::bigint) FROM pkg)
  UNION ALL SELECT 11, NULL, (SELECT max("openItemCount") FROM pkg)
  UNION ALL SELECT 12, (SELECT bool_and("sizeBytes" > 0 AND "sha256" IS NOT NULL AND length("sha256") = 64) FROM pkg), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "AccountantDelivery")
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" LIKE 'DELIVERY\_%' OR "eventType" LIKE 'LINK\_%')
  UNION ALL SELECT 15, (SELECT count(*) = 1 AND bool_and("businessId" = 9 AND state::text = 'ENABLED') FROM ovr), NULL
  UNION ALL SELECT 16, NULL, (SELECT (SELECT count(*) FROM "AccountantPeriod" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantPackage" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "businessId" <> 9))
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
