-- ============================================================================
-- activity-packs-open-all-preflight.sql
--
-- Read-only Production facts BEFORE migration 20261221200000_activity_packs_open_all (activity_packs available to
-- every business). Flags, counts and fingerprints only (scripts/ci/evidence-redact.mjs): no id, name or text.
-- Rows 12, 13 and 15 are fingerprints the post-apply evidence file must reproduce exactly.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== activity packs open-all preflight: legend =='
\echo ' 1 activity_packs definition present and default off (flag; expected true)'
\echo ' 2 activity_packs policy present, global off, no emergency switch (flag; expected true)'
\echo ' 3 ledger: 20261216090000_activity_packs finished (count; expected 1)'
\echo ' 4 ledger: 20261221190000_service_desk_open_all finished (count; expected 1, the migration just before)'
\echo ' 5 ledger: 20261221200000_activity_packs_open_all recorded (count; expected 0)'
\echo ' 6 ledger: 20261222090000_service_desk_case_records recorded (count; 0 = this one releases alone)'
\echo ' 7 activity_packs overrides ENABLED (count; expected 1, business 9)'
\echo ' 8 activity_packs overrides DISABLED (count; expected 0)'
\echo ' 9 saved activity choices, BusinessActivityProfile rows (count; expected 1, business 9)'
\echo '10 live businesses (count; information)'
\echo '11 live businesses still in the signup flow, onboarding not completed (count; information: offered the skippable screens)'
\echo '12 BusinessActivityProfile table privileges (fingerprint; identical after the apply)'
\echo '13 BusinessActivityProfile row-level policies (fingerprint; identical after the apply)'
\echo '14 BusinessActivityProfile FORCE row-level security (flag; expected true)'
\echo '15 every OTHER feature: policy + definition defaults (fingerprint; identical after the apply)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
live AS (
  SELECT b."id" FROM "Business" b
  WHERE b."name" <> '__PLATFORM_SYSTEM__'
    AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
led AS (
  SELECT m."migration_name" AS name, (m."finished_at" IS NOT NULL AND m."rolled_back_at" IS NULL) AS done
  FROM "_prisma_migrations" m
),
lines(n, flag, observed_count) AS (
            SELECT 1, COALESCE((SELECT bool_and(NOT d."defaultEnabled") FROM "PlatformFeatureDefinition" d WHERE d."key" = 'activity_packs'), false), NULL::bigint
  UNION ALL SELECT 2, COALESCE((SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p
                                 WHERE p."featureKey" = 'activity_packs'), false), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM led WHERE led.name = '20261216090000_activity_packs' AND led.done)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM led WHERE led.name = '20261221190000_service_desk_open_all' AND led.done)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM led WHERE led.name = '20261221200000_activity_packs_open_all')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM led WHERE led.name = '20261222090000_service_desk_case_records')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'activity_packs' AND a.state::text = 'ENABLED')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'activity_packs' AND a.state::text = 'DISABLED')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "BusinessActivityProfile")
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM live)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM live l LEFT JOIN "BusinessProfile" bp ON bp."businessId" = l."id"
                               WHERE bp."onboardingCompletedAt" IS NULL)
  UNION ALL SELECT 12, NULL, (SELECT COALESCE(hashtext(string_agg(g.grantee || ':' || g.privilege_type, ',' ORDER BY g.grantee, g.privilege_type)), 0)::bigint
                               FROM information_schema.role_table_grants g
                               WHERE g.table_schema = 'public' AND g.table_name = 'BusinessActivityProfile')
  UNION ALL SELECT 13, NULL, (SELECT COALESCE(hashtext(string_agg(p.policyname || '|' || p.cmd || '|' || COALESCE(p.qual, '') || '|' || COALESCE(p.with_check, ''),
                                                                  ',' ORDER BY p.policyname)), 0)::bigint
                               FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'BusinessActivityProfile')
  UNION ALL SELECT 14, COALESCE((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c
                                 JOIN pg_namespace s ON s.oid = c.relnamespace
                                 WHERE s.nspname = 'public' AND c.relname = 'BusinessActivityProfile'), false), NULL
  UNION ALL SELECT 15, NULL, (SELECT COALESCE(hashtext(
                                 (SELECT string_agg(p."featureKey" || '=' || p."globalEnabled"::text || '/' || p."emergencyDisabled"::text, ',' ORDER BY p."featureKey")
                                    FROM "PlatformFeaturePolicy" p WHERE p."featureKey" <> 'activity_packs')
                                 || '#' ||
                                 (SELECT string_agg(d."key" || '=' || d."defaultEnabled"::text, ',' ORDER BY d."key")
                                    FROM "PlatformFeatureDefinition" d WHERE d."key" <> 'activity_packs')), 0)::bigint)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
