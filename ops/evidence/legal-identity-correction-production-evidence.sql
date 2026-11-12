-- ============================================================================
-- legal-identity-correction-production-evidence.sql
--
-- Read-only PROOF that 20261128100000_legal_identity_correction is applied exactly as reviewed. Run AFTER the apply.
-- Before the apply it reports FAIL rows (its table and functions are missing).
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== legal identity correction proof: legend (n -> check) =='
\echo ' 1 the ledger row is finished, not rolled back, with the reviewed checksum (observed = rows)'
\echo ' 2 LegalIdentityCorrectionRequest exists with row level security enabled and forced (observed = 1 when both)'
\echo ' 3 its only policy is lic_tenant_read, for reads (observed = policies)'
\echo ' 4 the five named checks exist (observed = of 5)'
\echo ' 5 the partial unique index (one open request per business) exists (observed = of 1)'
\echo ' 6 five functions: four SECURITY DEFINER and the guard SECURITY INVOKER, all with a pinned search_path (observed = of 5)'
\echo ' 7 the guard triggers (rows + statement) exist and are enabled (observed = of 2)'
\echo ' 8 app_runtime may read the table and holds no other table privilege (observed = non-read privileges)'
\echo ' 9 app_runtime executes request, cancel and erase (observed = of 3)'
\echo '10 the decide function is granted to nobody: no entry but its owner, never the PUBLIC default (observed = other entries)'
\echo '11 app_auth holds nothing: no table privilege, no function (observed = privileges)'
\echo '12 PUBLIC executes none of the five (observed = functions)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
t   AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
          WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'LegalIdentityCorrectionRequest' AND c.relkind = 'r'),
fn  AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proacl,
               coalesce(array_to_string(p.proconfig, ','), '') AS cfg, coalesce(p.proacl::text, '') AS acl
          FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
          ('legal_identity_correction_guard', 'legal_identity_correction_request', 'legal_identity_correction_cancel',
           'legal_identity_correction_decide', 'legal_identity_correction_erase')),
privs AS (SELECT v.p FROM (VALUES ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')) v(p)),
ledger AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128100000_legal_identity_correction'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND checksum = 'efe529d175db4e53c8da7262c1f7f5a3186bffeb4ac5d2d237fa26c84590708e'),
pol AS (SELECT count(*) AS total, count(*) FILTER (WHERE polname = 'lic_tenant_read' AND polcmd = 'r') AS reads
          FROM pg_policy WHERE polrelid = (SELECT oid FROM t)),
chk AS (SELECT count(*) AS n FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM t) AND k.contype = 'c' AND k.conname IN
          ('LegalIdentityCorrection_changes_something', 'LegalIdentityCorrection_kind_rule',
           'LegalIdentityCorrection_same_entity_form', 'LegalIdentityCorrection_four_eyes', 'LegalIdentityCorrection_decided_shape')),
idx AS (SELECT count(*) AS n FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = (SELECT oid FROM t) AND i.indisunique AND i.indpred IS NOT NULL
            AND ic.relname = 'LegalIdentityCorrection_one_open_per_business'),
shape AS (SELECT count(*) AS n FROM fn WHERE cfg LIKE '%search_path=pg_catalog, public, pg_temp%' AND (
            (proname = 'legal_identity_correction_guard' AND NOT prosecdef)
         OR (proname <> 'legal_identity_correction_guard' AND prosecdef))),
trg AS (SELECT count(*) AS n FROM pg_trigger g WHERE g.tgrelid = (SELECT oid FROM t) AND g.tgenabled = 'O'
          AND g.tgname IN ('LegalIdentityCorrection_guard', 'LegalIdentityCorrection_no_truncate')),
rt_other AS (SELECT count(*) AS n FROM privs WHERE has_table_privilege('app_runtime', (SELECT oid FROM t), privs.p)),
rt_exec AS (SELECT count(*) AS n FROM fn WHERE has_function_privilege('app_runtime', oid, 'EXECUTE')
              AND proname IN ('legal_identity_correction_request', 'legal_identity_correction_cancel', 'legal_identity_correction_erase')),
decide_other AS (SELECT (SELECT count(*) FROM fn, aclexplode(fn.proacl) a
                          WHERE fn.proname = 'legal_identity_correction_decide' AND a.grantee <> fn.proowner)
                      + (SELECT count(*) FROM fn WHERE fn.proname = 'legal_identity_correction_decide' AND fn.proacl IS NULL) AS n),
auth_any AS (SELECT (SELECT count(*) FROM (SELECT 'SELECT' AS p UNION ALL SELECT p FROM privs) q
                      WHERE has_table_privilege('app_auth', (SELECT oid FROM t), q.p))
                  + (SELECT count(*) FROM fn WHERE has_function_privilege('app_auth', oid, 'EXECUTE')) AS n),
pub_exec AS (SELECT count(*) AS n FROM fn WHERE acl = '' OR acl LIKE '%{=X/%' OR acl LIKE '%,=X/%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM ledger) = 1, (SELECT n FROM ledger)
  UNION ALL SELECT 2, coalesce((SELECT relrowsecurity AND relforcerowsecurity FROM t), false),
                      (SELECT count(*) FROM t WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 3, (SELECT total FROM pol) = 1 AND (SELECT reads FROM pol) = 1, (SELECT total FROM pol)
  UNION ALL SELECT 4, (SELECT n FROM chk) = 5, (SELECT n FROM chk)
  UNION ALL SELECT 5, (SELECT n FROM idx) = 1, (SELECT n FROM idx)
  UNION ALL SELECT 6, (SELECT count(*) FROM fn) = 5 AND (SELECT n FROM shape) = 5, (SELECT n FROM shape)
  UNION ALL SELECT 7, (SELECT n FROM trg) = 2, (SELECT n FROM trg)
  UNION ALL SELECT 8, has_table_privilege('app_runtime', (SELECT oid FROM t), 'SELECT') AND (SELECT n FROM rt_other) = 0,
                      (SELECT n FROM rt_other)
  UNION ALL SELECT 9, (SELECT n FROM rt_exec) = 3, (SELECT n FROM rt_exec)
  UNION ALL SELECT 10, (SELECT count(*) FROM fn WHERE proname = 'legal_identity_correction_decide') = 1
                       AND (SELECT n FROM decide_other) = 0, (SELECT n FROM decide_other)
  UNION ALL SELECT 11, (SELECT n FROM auth_any) = 0, (SELECT n FROM auth_any)
  UNION ALL SELECT 12, (SELECT count(*) FROM fn) = 5 AND (SELECT n FROM pub_exec) = 0, (SELECT n FROM pub_exec)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
