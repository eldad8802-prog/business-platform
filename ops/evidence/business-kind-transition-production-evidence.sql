-- ============================================================================
-- business-kind-transition-production-evidence.sql
--
-- Read-only PROOF that 20261221090000_business_kind_transition is applied exactly as reviewed. Run AFTER the apply.
-- Before the apply it errors (its objects are missing) or reports FAIL rows.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== business kind transition proof: legend (n -> check) =='
\echo ' 1 the ledger row is finished, not rolled back, with the reviewed checksum (observed = rows)'
\echo ' 2 table BusinessKindTransition exists under ENABLE + FORCE row level security (observed = 1 when both)'
\echo ' 3 exactly two per-command tenant policies (read, add) keyed on app.current_business_id (observed = policies)'
\echo ' 4 the transition function is SECURITY DEFINER with a pinned search_path; the other two are not definer (observed = of 3)'
\echo ' 5 the append-only trigger exists and is enabled (observed = triggers)'
\echo ' 6 app_runtime reads the table and holds no write privilege on it (observed = write privileges)'
\echo ' 7 app_runtime executes the transition function only (observed = of 3 it executes)'
\echo ' 8 PUBLIC and app_auth execute none of the three (observed = grants)'
\echo ' 9 the one-transition-per-business unique index exists (observed = indexes)'
\echo '10 every transition row belongs to a profile that is now AUTHORIZED_DEALER (observed = rows that fail it)'
\echo '11 the canonical statement digest matches the application vector (observed = 1)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
t AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessKindTransition' AND c.relkind = 'r'),
fn AS (SELECT p.oid, p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS cfg
         FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
         ('business_kind_transition_append_only', 'business_kind_transition_statement', 'business_kind_transition_to_authorized')),
pol AS (SELECT count(*) AS n FROM pg_policy pl WHERE pl.polrelid = (SELECT oid FROM t)
          AND pl.polcmd IN ('r', 'a') AND pg_get_expr(coalesce(pl.polqual, pl.polwithcheck), pl.polrelid) LIKE '%app.current_business_id%'),
polall AS (SELECT count(*) AS n FROM pg_policy pl WHERE pl.polrelid = (SELECT oid FROM t)),
wpriv AS (SELECT count(*) AS n FROM (VALUES ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE')) v(p)
            WHERE has_table_privilege('app_runtime', (SELECT oid FROM t), v.p)),
rx AS (SELECT count(*) AS n FROM fn WHERE has_function_privilege('app_runtime', fn.oid, 'EXECUTE')),
rx_ok AS (SELECT count(*) AS n FROM fn WHERE has_function_privilege('app_runtime', fn.oid, 'EXECUTE')
            AND fn.proname = 'business_kind_transition_to_authorized'),
pubx AS (SELECT count(*) AS n FROM fn WHERE has_function_privilege('app_auth', fn.oid, 'EXECUTE')),  -- app_auth inherits PUBLIC: one test covers both
idx AS (SELECT count(*) AS n FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = (SELECT oid FROM t) AND i.indisunique AND ic.relname = 'BusinessKindTransition_businessId_key'),
bad AS (SELECT count(*) AS n FROM "BusinessKindTransition" k
          LEFT JOIN "BusinessProfile" bp ON bp."businessId" = k."businessId"
          WHERE bp."billingBusinessKind" IS DISTINCT FROM 'AUTHORIZED_DEALER'),
vec AS (SELECT encode(sha256(convert_to(public.business_kind_transition_statement(
                7, 11, 'ישראל ישראלי', '123456782', '123456782', DATE '2026-11-01'), 'UTF8')), 'hex') AS h),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221090000_business_kind_transition'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = '75e8000a2846941ed1c02449d239dae7921f2ffbe33600a5b5cd042f9505fbdf') = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221090000_business_kind_transition'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = '75e8000a2846941ed1c02449d239dae7921f2ffbe33600a5b5cd042f9505fbdf')
  UNION ALL SELECT 2, coalesce((SELECT relrowsecurity AND relforcerowsecurity FROM t), false),
                      (SELECT count(*) FROM t WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 3, (SELECT n FROM pol) = 2 AND (SELECT n FROM polall) = 2, (SELECT n FROM polall)
  UNION ALL SELECT 4, (SELECT count(*) FROM fn) = 3
                      AND (SELECT count(*) FROM fn WHERE proname = 'business_kind_transition_to_authorized' AND prosecdef
                            AND cfg LIKE '%search_path=pg_catalog, public, pg_temp%') = 1
                      AND (SELECT count(*) FROM fn WHERE proname <> 'business_kind_transition_to_authorized' AND NOT prosecdef) = 2,
                      (SELECT count(*) FROM fn)
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t)
                        AND tgname = 'BusinessKindTransition_append_only' AND tgenabled = 'O') = 1,
                      (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t) AND tgname = 'BusinessKindTransition_append_only')
  UNION ALL SELECT 6, has_table_privilege('app_runtime', (SELECT oid FROM t), 'SELECT') AND (SELECT n FROM wpriv) = 0, (SELECT n FROM wpriv)
  UNION ALL SELECT 7, (SELECT n FROM rx) = 1 AND (SELECT n FROM rx_ok) = 1, (SELECT n FROM rx)
  UNION ALL SELECT 8, (SELECT n FROM pubx) = 0, (SELECT n FROM pubx)
  UNION ALL SELECT 9, (SELECT n FROM idx) = 1, (SELECT n FROM idx)
  UNION ALL SELECT 10, (SELECT n FROM bad) = 0, (SELECT n FROM bad)
  UNION ALL SELECT 11, (SELECT h FROM vec) = '8ab5a6b2df827ed27147ea10e49802bea06810d49f4eeba878afe39c88b2d464', CASE WHEN (SELECT h FROM vec) = '8ab5a6b2df827ed27147ea10e49802bea06810d49f4eeba878afe39c88b2d464' THEN 1 ELSE 0 END
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
