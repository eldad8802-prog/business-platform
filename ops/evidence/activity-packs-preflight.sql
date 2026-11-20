-- Activity packs (20261216090000_activity_packs) — PREFLIGHT. SELECT-only, safe to run in Production.
-- Prints one line per check (PASS/FAIL) and PREFLIGHT_OK only when every check passes. Changes nothing.
WITH checks(n, name, ok) AS (
  VALUES
    (1, 'Business table exists', to_regclass('public."Business"') IS NOT NULL),
    (2, 'platform feature tables exist', to_regclass('public."PlatformFeatureDefinition"') IS NOT NULL AND to_regclass('public."PlatformFeaturePolicy"') IS NOT NULL),
    (3, 'role app_runtime exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')),
    (4, 'BusinessActivityProfile does not exist yet', to_regclass('public."BusinessActivityProfile"') IS NULL),
    (5, 'guard function does not exist yet', to_regprocedure('public.business_activity_profile_guard()') IS NULL),
    (6, 'feature definition activity_packs absent', NOT EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs')),
    (7, 'feature policy activity_packs absent', NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs')),
    (8, 'no per-business override for activity_packs', NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'activity_packs'))
)
SELECT format('%s %s — %s', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, n, name) FROM checks
UNION ALL
SELECT CASE WHEN bool_and(ok) THEN 'PREFLIGHT_OK' ELSE 'PREFLIGHT_FAILED' END FROM checks;
