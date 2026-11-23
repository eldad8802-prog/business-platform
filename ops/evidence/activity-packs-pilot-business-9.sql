-- ============================================================================
-- activity-packs-pilot-business-9.sql
--
-- Read-only Production facts for the activity_packs pilot on the TEST business (businessId = 9, #1219), and the
-- proof that no other business is touched. Run three times:
--   S1 baseline   before the owner switches anything (expected: no override anywhere, no choice anywhere);
--   S2 switch-on  right after the owner opens activity_packs for business 9 in the platform admin
--                 (expected: 2 = true, 9 = 1, 10-12 = true; everything else = S1);
--   S3 after the phone test, and again after any switch-off (14 may become 1 — the owner's own choice — and a
--      switch-off keeps it).
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name or text reaches the log; the switch-on
-- reason is compared inside the query, never printed. Row 16 is a consistency fingerprint of business 9's OTHER
-- feature overrides (key + state): it must be identical in S1, S2 and S3.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== activity packs pilot, business 9: legend =='
\echo ' 1 business 9 exists, is not the platform system business, not archived, not in deletion (flag)'
\echo ' 2 business 9: activity_packs override is ENABLED (flag)'
\echo ' 3 business 9: activity_packs override is DISABLED (flag)'
\echo ' 4 business 9: no effective activity_packs override (no row or INHERIT) (flag)'
\echo ' 5 OTHER businesses with an activity_packs override ENABLED (count; expected 0)'
\echo ' 6 OTHER businesses with any activity_packs override row (count; expected 0)'
\echo ' 7 activity_packs: global policy off and no emergency switch (flag; expected true)'
\echo ' 8 activity_packs: catalog definition default off (flag; expected true)'
\echo ' 9 audit: activity_packs access changes for business 9 (count)'
\echo '10 audit: the latest one is ENABLED, effective after = allowed, with the owner reason text (flag)'
\echo '11 audit: its actor is a platform admin (flag)'
\echo '12 audit: it happened in the last 24 hours (flag)'
\echo '13 audit: activity_packs access changes for OTHER businesses (count; expected 0)'
\echo '14 business 9: saved activity choice rows (count; 0 until the owner chooses on the phone, then 1)'
\echo '15 OTHER businesses: saved activity choice rows (count; expected 0)'
\echo '16 business 9: fingerprint of its OTHER feature overrides, key + state (number; identical in S1, S2, S3)'
\echo '17 business 9: OTHER feature overrides (count; identical in S1, S2, S3)'
\echo '18 audit: access changes for business 9 on OTHER features in the last 24 hours (count; expected 0)'
\echo '19 migration 20261216090000_activity_packs recorded once and finished (count; expected 1)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
biz AS (
  SELECT b."id" FROM "Business" b
  WHERE b."id" = 9 AND b."name" <> '__PLATFORM_SYSTEM__'
    AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
o9 AS (SELECT a.state::text AS state FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" = 'activity_packs'),
x9 AS (SELECT a."featureKey", a.state::text AS state FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" <> 'activity_packs'),
ev AS (
  SELECT e."id", e."actorUserId", e."createdAt", e."targetId", e."metadata"
  FROM "PlatformAuditEvent" e
  WHERE e."action" = 'PLATFORM_FEATURE_ACCESS_UPDATED' AND e."metadata"->>'featureKey' = 'activity_packs'
),
last9 AS (SELECT * FROM ev WHERE ev."targetId" = '9' ORDER BY ev."createdAt" DESC, ev."id" DESC LIMIT 1),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM biz), NULL::bigint
  UNION ALL SELECT 2, COALESCE((SELECT bool_or(state = 'ENABLED') FROM o9), false), NULL
  UNION ALL SELECT 3, COALESCE((SELECT bool_or(state = 'DISABLED') FROM o9), false), NULL
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM o9 WHERE state IN ('ENABLED', 'DISABLED')), NULL
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a
                              WHERE a."featureKey" = 'activity_packs' AND a."businessId" <> 9 AND a.state::text = 'ENABLED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'activity_packs' AND a."businessId" <> 9)
  UNION ALL SELECT 7, COALESCE((SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p
                                 WHERE p."featureKey" = 'activity_packs'), false), NULL
  UNION ALL SELECT 8, COALESCE((SELECT bool_and(NOT d."defaultEnabled") FROM "PlatformFeatureDefinition" d WHERE d."key" = 'activity_packs'), false), NULL
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM ev WHERE ev."targetId" = '9')
  UNION ALL SELECT 10, COALESCE((SELECT l."metadata"->>'newState' = 'ENABLED'
                                    AND l."metadata"->>'effectiveAllowedAfter' = 'true'
                                    AND l."metadata"->>'reason' = 'פיילוט מבוקר של חבילות הפעילות'
                                  FROM last9 l), false), NULL
  UNION ALL SELECT 11, COALESCE((SELECT u."role"::text = 'PLATFORM_ADMIN' FROM last9 l JOIN "User" u ON u."id" = l."actorUserId"), false), NULL
  UNION ALL SELECT 12, COALESCE((SELECT l."createdAt" >= now() - interval '24 hours' FROM last9 l), false), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM ev WHERE ev."targetId" IS DISTINCT FROM '9')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "BusinessActivityProfile" p WHERE p."businessId" = 9)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "BusinessActivityProfile" p WHERE p."businessId" <> 9)
  UNION ALL SELECT 16, NULL, (SELECT COALESCE(hashtext(string_agg(x."featureKey" || '=' || x.state, ',' ORDER BY x."featureKey")), 0)::bigint FROM x9 x)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM x9)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM "PlatformAuditEvent" e
                               WHERE e."action" = 'PLATFORM_FEATURE_ACCESS_UPDATED' AND e."targetId" = '9'
                                 AND e."metadata"->>'featureKey' IS DISTINCT FROM 'activity_packs'
                                 AND e."createdAt" >= now() - interval '24 hours')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM "_prisma_migrations" m
                               WHERE m."migration_name" = '20261216090000_activity_packs'
                                 AND m."finished_at" IS NOT NULL AND m."rolled_back_at" IS NULL)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
