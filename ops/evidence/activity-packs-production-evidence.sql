-- Activity packs (20261216090000_activity_packs) — EVIDENCE after the release. SELECT-only, safe in Production.
-- Prints one line per check (PASS/FAIL) and EVIDENCE_OK only when every check passes. Changes nothing.
WITH checks(n, name, ok) AS (
  VALUES
    (1, 'BusinessActivityProfile exists', to_regclass('public."BusinessActivityProfile"') IS NOT NULL),
    (2, 'FORCE RLS on', COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public."BusinessActivityProfile"')), false)),
    (3, 'three tenant policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'BusinessActivityProfile') = 3),
    (4, 'app_runtime has SELECT, INSERT, UPDATE', to_regclass('public."BusinessActivityProfile"') IS NOT NULL
        AND has_table_privilege('app_runtime', 'public."BusinessActivityProfile"', 'SELECT, INSERT, UPDATE')),
    (5, 'app_runtime has no DELETE / TRUNCATE', to_regclass('public."BusinessActivityProfile"') IS NOT NULL
        AND NOT has_table_privilege('app_runtime', 'public."BusinessActivityProfile"', 'DELETE')
        AND NOT has_table_privilege('app_runtime', 'public."BusinessActivityProfile"', 'TRUNCATE')),
    (6, 'guard trigger present', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'BusinessActivityProfile_guard' AND NOT tgisinternal)),
    (7, 'feature definition OFF by default', EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs' AND "defaultEnabled" = false)),
    (8, 'feature policy globally OFF', EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs' AND "globalEnabled" = false AND "emergencyDisabled" = false)),
    (9, 'no per-business override yet', NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'activity_packs'))
)
SELECT format('%s %s — %s', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, n, name) FROM checks
UNION ALL
SELECT CASE WHEN bool_and(ok) THEN 'EVIDENCE_OK' ELSE 'EVIDENCE_FAILED' END FROM checks;
