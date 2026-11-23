-- ============================================================================
-- activity-packs-open-all-production-evidence.sql
--
-- Read-only Production facts AFTER migration 20261221200000_activity_packs_open_all. Rows 4-8 and 10 must equal the
-- preflight's rows 7, 8, 9, 12, 13 and 15 (the migration switches two rows and nothing else). Rerun later as the
-- rollout monitor: rows 11-13 show how many owners chose, and how many businesses were closed one by one.
-- Flags, counts and fingerprints only. Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== activity packs open-all evidence: legend =='
\echo ' 1 activity_packs definition default on (flag; expected true)'
\echo ' 2 activity_packs policy global on, no emergency switch (flag; expected true)'
\echo ' 3 ledger: 20261221200000_activity_packs_open_all finished (count; expected 1)'
\echo ' 4 activity_packs overrides ENABLED (count; = preflight 7)'
\echo ' 5 activity_packs overrides DISABLED (count; = preflight 8 right after the apply)'
\echo ' 6 saved activity choices (count; = preflight 9 right after the apply: nothing chosen for anyone)'
\echo ' 7 BusinessActivityProfile table privileges (fingerprint; = preflight 12)'
\echo ' 8 BusinessActivityProfile row-level policies (fingerprint; = preflight 13)'
\echo ' 9 BusinessActivityProfile FORCE row-level security (flag; expected true)'
\echo '10 every OTHER feature: policy + definition defaults (fingerprint; = preflight 15)'
\echo '11 monitor: saved choices made in the last 24 hours (count)'
\echo '12 monitor: activity_packs access changes in the audit, last 24 hours (count)'
\echo '13 monitor: saved choices on a business that is not live (count; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
live AS (
  SELECT b."id" FROM "Business" b
  WHERE b."name" <> '__PLATFORM_SYSTEM__'
    AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
lines(n, flag, observed_count) AS (
            SELECT 1, COALESCE((SELECT bool_and(d."defaultEnabled") FROM "PlatformFeatureDefinition" d WHERE d."key" = 'activity_packs'), false), NULL::bigint
  UNION ALL SELECT 2, COALESCE((SELECT bool_and(p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p
                                 WHERE p."featureKey" = 'activity_packs'), false), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" m
                              WHERE m."migration_name" = '20261221200000_activity_packs_open_all'
                                AND m."finished_at" IS NOT NULL AND m."rolled_back_at" IS NULL)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'activity_packs' AND a.state::text = 'ENABLED')
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'activity_packs' AND a.state::text = 'DISABLED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessActivityProfile")
  UNION ALL SELECT 7, NULL, (SELECT COALESCE(hashtext(string_agg(g.grantee || ':' || g.privilege_type, ',' ORDER BY g.grantee, g.privilege_type)), 0)::bigint
                               FROM information_schema.role_table_grants g
                               WHERE g.table_schema = 'public' AND g.table_name = 'BusinessActivityProfile')
  UNION ALL SELECT 8, NULL, (SELECT COALESCE(hashtext(string_agg(p.policyname || '|' || p.cmd || '|' || COALESCE(p.qual, '') || '|' || COALESCE(p.with_check, ''),
                                                                 ',' ORDER BY p.policyname)), 0)::bigint
                               FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'BusinessActivityProfile')
  UNION ALL SELECT 9, COALESCE((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c
                                JOIN pg_namespace s ON s.oid = c.relnamespace
                                WHERE s.nspname = 'public' AND c.relname = 'BusinessActivityProfile'), false), NULL
  UNION ALL SELECT 10, NULL, (SELECT COALESCE(hashtext(
                                 (SELECT string_agg(p."featureKey" || '=' || p."globalEnabled"::text || '/' || p."emergencyDisabled"::text, ',' ORDER BY p."featureKey")
                                    FROM "PlatformFeaturePolicy" p WHERE p."featureKey" <> 'activity_packs')
                                 || '#' ||
                                 (SELECT string_agg(d."key" || '=' || d."defaultEnabled"::text, ',' ORDER BY d."key")
                                    FROM "PlatformFeatureDefinition" d WHERE d."key" <> 'activity_packs')), 0)::bigint)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BusinessActivityProfile" p WHERE p."updatedAt" >= now() - interval '24 hours')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "PlatformAuditEvent" e
                               WHERE e."action" = 'PLATFORM_FEATURE_ACCESS_UPDATED' AND e."metadata"->>'featureKey' = 'activity_packs'
                                 AND e."createdAt" >= now() - interval '24 hours')
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "BusinessActivityProfile" p WHERE p."businessId" NOT IN (SELECT l."id" FROM live l))
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
