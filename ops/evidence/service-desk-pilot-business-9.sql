-- ============================================================================
-- service-desk-pilot-business-9.sql
--
-- Read-only Production facts for the Service Desk pilot on the TEST business (businessId = 9, owner decision
-- 2026-11-20, #1206), and the proof that no other business is touched. Run before the switch-on (baseline: no
-- override anywhere), right after the owner switches `service_desk` ON for business 9 through the platform admin,
-- and again after any switch-off.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, amount or text reaches the log; the
-- switch-on reason is compared inside the query, never printed.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== service desk pilot, business 9: legend =='
\echo ' 1 business 9 exists, is not the platform system business, not archived, not in deletion (flag)'
\echo ' 2 business 9: service_desk override is ENABLED (flag)'
\echo ' 3 business 9: service_desk override is DISABLED (flag)'
\echo ' 4 business 9: no effective service_desk override (no row or INHERIT) (flag)'
\echo ' 5 OTHER businesses with a service_desk override ENABLED (count; expected 0)'
\echo ' 6 OTHER businesses with any service_desk override row (count; a baseline)'
\echo ' 7 service_desk: global policy off and no emergency switch (flag; expected true)'
\echo ' 8 service_desk: catalog definition default off (flag; expected true)'
\echo ' 9 audit: service_desk access changes for business 9 (count)'
\echo '10 audit: the latest one is ENABLED, effective after = allowed, with the owner reason text (flag)'
\echo '11 audit: its actor is a platform admin (flag)'
\echo '12 audit: it happened in the last 24 hours (flag)'
\echo '13 audit: service_desk access changes for OTHER businesses (count; a baseline)'
\echo '14 business 9: service cases (count)'
\echo '15 OTHER businesses: service cases (count; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
biz AS (
  SELECT b."id" FROM "Business" b
  WHERE b."id" = 9 AND b."name" <> '__PLATFORM_SYSTEM__'
    AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
o9 AS (SELECT a.state::text AS state FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" = 'service_desk'),
ev AS (
  SELECT e."id", e."actorUserId", e."createdAt", e."targetId", e."metadata"
  FROM "PlatformAuditEvent" e
  WHERE e."action" = 'PLATFORM_FEATURE_ACCESS_UPDATED' AND e."metadata"->>'featureKey' = 'service_desk'
),
last9 AS (SELECT * FROM ev WHERE ev."targetId" = '9' ORDER BY ev."createdAt" DESC, ev."id" DESC LIMIT 1),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM biz), NULL::bigint
  UNION ALL SELECT 2, COALESCE((SELECT bool_or(state = 'ENABLED') FROM o9), false), NULL
  UNION ALL SELECT 3, COALESCE((SELECT bool_or(state = 'DISABLED') FROM o9), false), NULL
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM o9 WHERE state IN ('ENABLED', 'DISABLED')), NULL
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a
                              WHERE a."featureKey" = 'service_desk' AND a."businessId" <> 9 AND a.state::text = 'ENABLED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'service_desk' AND a."businessId" <> 9)
  UNION ALL SELECT 7, COALESCE((SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p
                                 WHERE p."featureKey" = 'service_desk'), false), NULL
  UNION ALL SELECT 8, COALESCE((SELECT bool_and(NOT d."defaultEnabled") FROM "PlatformFeatureDefinition" d WHERE d."key" = 'service_desk'), false), NULL
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM ev WHERE ev."targetId" = '9')
  UNION ALL SELECT 10, COALESCE((SELECT l."metadata"->>'newState' = 'ENABLED'
                                    AND l."metadata"->>'effectiveAllowedAfter' = 'true'
                                    AND l."metadata"->>'reason' = 'פיילוט מבוקר של מערכת התיקונים והשירות'
                                  FROM last9 l), false), NULL
  UNION ALL SELECT 11, COALESCE((SELECT u."role"::text = 'PLATFORM_ADMIN' FROM last9 l JOIN "User" u ON u."id" = l."actorUserId"), false), NULL
  UNION ALL SELECT 12, COALESCE((SELECT l."createdAt" >= now() - interval '24 hours' FROM last9 l), false), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM ev WHERE ev."targetId" IS DISTINCT FROM '9')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "ServiceCase" c WHERE c."businessId" = 9)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "ServiceCase" c WHERE c."businessId" <> 9)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
