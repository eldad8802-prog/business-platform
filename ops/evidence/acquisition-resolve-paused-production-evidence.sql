-- ============================================================================
-- acquisition-resolve-paused-production-evidence.sql
--
-- Read-only Production PROOF after release-migrate applied 20261110100000_acquisition_resolve_paused_hold
-- (Leads L1.5-a, decision 3). The migration only adds three v2 resolvers; this proves exactly that.
--
--   1 E1 the ledger holds the migration, finished, not rolled back, with the pinned checksum (observed = such rows)
--   2 E2 the three v2 resolvers exist with the expected arguments (observed = matching functions)
--   3 E3 each is SECURITY DEFINER and STABLE (observed = functions that are)
--   4 E4 each pins search_path = pg_catalog, public, pg_temp (observed = functions pinning it)
--   5 E5 each is executable by app_runtime and NOT by PUBLIC (observed = functions that are right)
--   6 E6 each has the same owner as the v1 resolvers (observed = functions with that owner)
--   7 E7 keyed / public v2 resolve ACTIVE + PAUSED, resource v2 ACTIVE + ERROR + PAUSED; none names REVOKED (observed = bodies matching)
--   8 E8 v1 is untouched: ACTIVE only (keyed / public), ACTIVE + ERROR (resource), nothing PAUSED (observed = v1 bodies mentioning PAUSED)
--   9 E9 the evidence role bypasses row-level security, so every count is whole
--
-- OUTPUT: n | result | observed_count. PRIVACY: catalog facts only, no row data.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
v1 AS (SELECT p.oid, p.proname, p.proowner, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('m6_acquisition_resolve_keyed', 'm6_acquisition_resolve_public', 'm6_acquisition_resolve_resource')),
v2 AS (SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl,
              pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('m6_acquisition_resolve_keyed_v2', 'm6_acquisition_resolve_public_v2', 'm6_acquisition_resolve_resource_v2')),
args_ok AS (SELECT 1 FROM v2 WHERE
              (v2.proname = 'm6_acquisition_resolve_keyed_v2' AND v2.args = 'p_source_key text, p_public_id text, p_key_hash text')
           OR (v2.proname = 'm6_acquisition_resolve_public_v2' AND v2.args = 'p_source_key text, p_public_id text')
           OR (v2.proname = 'm6_acquisition_resolve_resource_v2' AND v2.args = 'p_source_key text, p_resource_id text')),
acl_ok AS (SELECT 1 FROM v2 WHERE v2.proacl IS NOT NULL
             AND has_function_privilege('app_runtime', v2.oid, 'EXECUTE')
             AND NOT EXISTS (SELECT 1 FROM aclexplode(v2.proacl) a WHERE a.grantee = 0)),
body_ok AS (SELECT 1 FROM v2 WHERE v2.def NOT LIKE '%REVOKED%' AND (
              (v2.proname IN ('m6_acquisition_resolve_keyed_v2', 'm6_acquisition_resolve_public_v2') AND v2.def LIKE '%IN (''ACTIVE'', ''PAUSED'')%')
           OR (v2.proname = 'm6_acquisition_resolve_resource_v2' AND v2.def LIKE '%IN (''ACTIVE'', ''ERROR'', ''PAUSED'')%'))),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = '06e41e9128567e9c6b44037370e077631c4d8475a2b4f6fb2a95862fb64fb17a') = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = '06e41e9128567e9c6b44037370e077631c4d8475a2b4f6fb2a95862fb64fb17a')
  UNION ALL SELECT 2, (SELECT count(*) FROM args_ok) = 3 AND (SELECT count(*) FROM v2) = 3, (SELECT count(*) FROM args_ok)
  UNION ALL SELECT 3, (SELECT count(*) FROM v2 WHERE v2.prosecdef AND v2.provolatile = 's') = 3,
                      (SELECT count(*) FROM v2 WHERE v2.prosecdef AND v2.provolatile = 's')
  UNION ALL SELECT 4, (SELECT count(*) FROM v2 WHERE v2.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) = 3,
                      (SELECT count(*) FROM v2 WHERE v2.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'])
  UNION ALL SELECT 5, (SELECT count(*) FROM acl_ok) = 3, (SELECT count(*) FROM acl_ok)
  UNION ALL SELECT 6, (SELECT count(*) FROM v2 WHERE v2.proowner = (SELECT v1.proowner FROM v1 WHERE v1.proname = 'm6_acquisition_resolve_keyed')) = 3,
                      (SELECT count(*) FROM v2 WHERE v2.proowner = (SELECT v1.proowner FROM v1 WHERE v1.proname = 'm6_acquisition_resolve_keyed'))
  UNION ALL SELECT 7, (SELECT count(*) FROM body_ok) = 3, (SELECT count(*) FROM body_ok)
  UNION ALL SELECT 8, (SELECT count(*) FROM v1) = 3 AND (SELECT count(*) FROM v1 WHERE v1.def LIKE '%PAUSED%') = 0
                        AND (SELECT count(*) FROM v1 WHERE v1.proname <> 'm6_acquisition_resolve_resource' AND v1.def LIKE '%"status" = ''ACTIVE''%') = 2
                        AND (SELECT count(*) FROM v1 WHERE v1.proname = 'm6_acquisition_resolve_resource' AND v1.def LIKE '%IN (''ACTIVE'', ''ERROR'')%') = 1,
                      (SELECT count(*) FROM v1 WHERE v1.def LIKE '%PAUSED%')
  UNION ALL SELECT 9, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                      (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
