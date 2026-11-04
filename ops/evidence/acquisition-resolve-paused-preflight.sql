-- ============================================================================
-- acquisition-resolve-paused-preflight.sql
--
-- Read-only Production PREFLIGHT for migration 20261110100000_acquisition_resolve_paused_hold (Leads L1.5-a,
-- decision 3): before the release, prove the database is in the state the migration expects.
--
--   1 P1 the migration is not in the ledger yet (pending) (observed = ledger rows for it)
--   2 P2 no migration in the ledger is unfinished or rolled back (observed = such rows)
--   3 P3 the three v2 resolvers are not there yet (observed = v2 functions present)                [fails after release]
--   4 P4 the three v1 resolvers exist, SECURITY DEFINER, executable by app_runtime (observed = v1 functions ok)
--   5 P5 v1 still resolves ACTIVE only (keyed / public) and ACTIVE + ERROR (resource) — nothing PAUSED (observed = v1 bodies mentioning PAUSED)
--   6 P6 the connection status vocabulary is ACTIVE / PAUSED / ERROR / REVOKED (observed = matching CHECK constraints)
--   7 P7 the role app_runtime exists (observed = roles)
--   8 P8 the evidence role bypasses row-level security, so every count is whole
--
-- OUTPUT: n | result | observed_count. PRIVACY: counts only, no row data.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
v1 AS (SELECT p.oid, p.proname, p.prosecdef, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('m6_acquisition_resolve_keyed', 'm6_acquisition_resolve_public', 'm6_acquisition_resolve_resource')),
v2 AS (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('m6_acquisition_resolve_keyed_v2', 'm6_acquisition_resolve_public_v2', 'm6_acquisition_resolve_resource_v2')),
v1_ok AS (SELECT 1 FROM v1 WHERE v1.prosecdef AND has_function_privilege('app_runtime', v1.oid, 'EXECUTE')),
status_check AS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                  WHERE t.relname = 'AcquisitionConnection' AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) LIKE '%ACTIVE%' AND pg_get_constraintdef(c.oid) LIKE '%PAUSED%'
                    AND pg_get_constraintdef(c.oid) LIKE '%ERROR%' AND pg_get_constraintdef(c.oid) LIKE '%REVOKED%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM v2) = 0, (SELECT count(*) FROM v2)
  UNION ALL SELECT 4, (SELECT count(*) FROM v1_ok) = 3, (SELECT count(*) FROM v1_ok)
  UNION ALL SELECT 5, (SELECT count(*) FROM v1 WHERE v1.def LIKE '%PAUSED%') = 0
                        AND (SELECT count(*) FROM v1 WHERE v1.proname <> 'm6_acquisition_resolve_resource' AND v1.def LIKE '%"status" = ''ACTIVE''%') = 2
                        AND (SELECT count(*) FROM v1 WHERE v1.proname = 'm6_acquisition_resolve_resource' AND v1.def LIKE '%IN (''ACTIVE'', ''ERROR'')%') = 1,
                      (SELECT count(*) FROM v1 WHERE v1.def LIKE '%PAUSED%')
  UNION ALL SELECT 6, (SELECT count(*) FROM status_check) >= 1, (SELECT count(*) FROM status_check)
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 1, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 8, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                      (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
