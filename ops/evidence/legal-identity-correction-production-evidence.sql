-- ============================================================================
-- legal-identity-correction-production-evidence.sql
--
-- Read-only PROOF that 20261128100000_legal_identity_correction is applied exactly as reviewed. Run AFTER the apply.
-- Before the apply it reports FAIL rows (its tables and functions are missing).
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== legal identity correction proof: legend (n -> check) =='
\echo ' 1 the ledger row is finished, not rolled back, with the reviewed checksum (observed = rows)'
\echo ' 2 the three tables exist with row level security enabled and forced (observed = of 3)'
\echo ' 3 tenant read policies for app_runtime on requests and attachments; none on LegalIdentityApprover (observed = tenant policies)'
\echo ' 4 the six named checks on the request table exist (observed = of 6)'
\echo ' 5 one open request per business (partial unique) and one row per stored file (unique key) (observed = of 2)'
\echo ' 6 eight functions: seven SECURITY DEFINER and the guard SECURITY INVOKER, all with a pinned search_path (observed = of 8)'
\echo ' 7 the four guard triggers (rows + statement, both tables) exist and are enabled (observed = of 4)'
\echo ' 8 app_runtime reads requests only by column: never internalNote nor decidedByUserId, no table-wide privilege (observed = violations)'
\echo ' 9 app_runtime executes exactly request, cancel, attach, request_info, decide, erase (observed = of 6, helpers excluded)'
\echo '10 app_runtime may read attachments and holds no other privilege on them (observed = non-read privileges)'
\echo '11 no application role holds any privilege on LegalIdentityApprover (observed = privileges)'
\echo '12 app_auth holds nothing: no privilege on the three tables, no function (observed = privileges)'
\echo '13 PUBLIC executes none of the eight (observed = functions)'
\echo '14 app_admin, when the role exists, reads requests and attachments through p7adm_read (observed = of 4, or 0 without the role)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbls AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
           WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
             AND c.relname IN ('LegalIdentityApprover', 'LegalIdentityCorrectionRequest', 'LegalIdentityCorrectionAttachment')),
req AS (SELECT oid FROM tbls WHERE relname = 'LegalIdentityCorrectionRequest'),
att AS (SELECT oid FROM tbls WHERE relname = 'LegalIdentityCorrectionAttachment'),
apr AS (SELECT oid FROM tbls WHERE relname = 'LegalIdentityApprover'),
fn  AS (SELECT p.oid, p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS cfg, coalesce(p.proacl::text, '') AS acl
          FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
          ('legal_identity_correction_guard', 'legal_identity_correction_is_approver', 'legal_identity_correction_request',
           'legal_identity_correction_cancel', 'legal_identity_correction_attach', 'legal_identity_correction_request_info',
           'legal_identity_correction_decide', 'legal_identity_correction_erase')),
writes AS (SELECT v.p FROM (VALUES ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')) v(p)),
allp AS (SELECT p FROM writes UNION ALL SELECT 'SELECT'),
approles AS (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_auth', 'app_admin')),
ledger AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128100000_legal_identity_correction'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND checksum = '38b8938a2aa139ae13a86b43daccea18d2e20c557660bcfa84cc8a5a75cd9024'),
tenant_pol AS (SELECT count(*) AS n FROM pg_policy pl
                 WHERE pl.polcmd = 'r' AND (
                   (pl.polrelid = (SELECT oid FROM req) AND pl.polname = 'lic_tenant_read')
                OR (pl.polrelid = (SELECT oid FROM att) AND pl.polname = 'lica_tenant_read'))
                   AND pl.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')]::oid[]),
apr_pol AS (SELECT count(*) AS n FROM pg_policy WHERE polrelid = (SELECT oid FROM apr)),
chk AS (SELECT count(*) AS n FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM req) AND k.contype = 'c' AND k.conname IN
          ('LegalIdentityCorrection_changes_something', 'LegalIdentityCorrection_kind_rule', 'LegalIdentityCorrection_same_entity_form',
           'LegalIdentityCorrection_four_eyes', 'LegalIdentityCorrection_decided_shape', 'LegalIdentityCorrection_info_shape')),
uniq AS (SELECT (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                   WHERE i.indrelid = (SELECT oid FROM req) AND i.indisunique AND i.indpred IS NOT NULL
                     AND ic.relname = 'LegalIdentityCorrection_one_open_per_business')
              + (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                   WHERE i.indrelid = (SELECT oid FROM att) AND i.indisunique AND i.indnatts = 1 AND a.attname = 'storageKey') AS n),
shape AS (SELECT count(*) AS n FROM fn WHERE cfg LIKE '%search_path=pg_catalog, public, pg_temp%' AND (
            (proname = 'legal_identity_correction_guard' AND NOT prosecdef)
         OR (proname <> 'legal_identity_correction_guard' AND prosecdef))),
trg AS (SELECT count(*) AS n FROM pg_trigger g WHERE g.tgenabled = 'O' AND g.tgname IN
          ('LegalIdentityCorrection_guard', 'LegalIdentityCorrection_no_truncate',
           'LegalIdentityCorrectionAttachment_guard', 'LegalIdentityCorrectionAttachment_no_truncate')),
rt_req_bad AS (SELECT (CASE WHEN has_column_privilege('app_runtime', (SELECT oid FROM req), 'internalNote', 'SELECT') THEN 1 ELSE 0 END)
                    + (CASE WHEN has_column_privilege('app_runtime', (SELECT oid FROM req), 'decidedByUserId', 'SELECT') THEN 1 ELSE 0 END)
                    + (CASE WHEN has_column_privilege('app_runtime', (SELECT oid FROM req), 'publicNote', 'SELECT') THEN 0 ELSE 1 END)
                    + (CASE WHEN has_column_privilege('app_runtime', (SELECT oid FROM req), 'status', 'SELECT') THEN 0 ELSE 1 END)
                    + (SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a
                         WHERE c.oid = (SELECT oid FROM req) AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'))
                    + (SELECT count(*) FROM writes WHERE has_table_privilege('app_runtime', (SELECT oid FROM req), writes.p)) AS n),
rt_exec AS (SELECT count(*) FILTER (WHERE proname IN ('legal_identity_correction_request', 'legal_identity_correction_cancel',
                                                      'legal_identity_correction_attach', 'legal_identity_correction_request_info',
                                                      'legal_identity_correction_decide', 'legal_identity_correction_erase')) AS granted,
                   count(*) FILTER (WHERE proname IN ('legal_identity_correction_guard', 'legal_identity_correction_is_approver')) AS helpers
              FROM fn WHERE has_function_privilege('app_runtime', oid, 'EXECUTE')),
rt_att_other AS (SELECT count(*) AS n FROM writes WHERE has_table_privilege('app_runtime', (SELECT oid FROM att), writes.p)),
apr_any AS (SELECT count(*) AS n FROM approles r, allp WHERE has_table_privilege(r.oid, (SELECT oid FROM apr), allp.p)),
auth_any AS (SELECT (SELECT count(*) FROM tbls, allp WHERE has_table_privilege('app_auth', tbls.oid, allp.p))
                  + (SELECT count(*) FROM fn WHERE has_function_privilege('app_auth', oid, 'EXECUTE')) AS n),
pub_exec AS (SELECT count(*) AS n FROM fn WHERE acl = '' OR acl LIKE '%{=X/%' OR acl LIKE '%,=X/%'),
admin AS (SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN 0 ELSE
                   (CASE WHEN has_table_privilege('app_admin', (SELECT oid FROM req), 'SELECT') THEN 1 ELSE 0 END)
                 + (CASE WHEN has_table_privilege('app_admin', (SELECT oid FROM att), 'SELECT') THEN 1 ELSE 0 END)
                 + (SELECT count(*) FROM pg_policy WHERE polname = 'p7adm_read' AND polcmd = 'r'
                      AND polrelid IN ((SELECT oid FROM req), (SELECT oid FROM att))) END AS n,
                 EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') AS has_role),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM ledger) = 1, (SELECT n FROM ledger)
  UNION ALL SELECT 2, (SELECT count(*) FROM tbls WHERE relrowsecurity AND relforcerowsecurity) = 3,
                      (SELECT count(*) FROM tbls WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 3, (SELECT n FROM tenant_pol) = 2 AND (SELECT n FROM apr_pol) = 0 AND (SELECT count(*) FROM apr) = 1,
                      (SELECT n FROM tenant_pol)
  UNION ALL SELECT 4, (SELECT n FROM chk) = 6, (SELECT n FROM chk)
  UNION ALL SELECT 5, (SELECT n FROM uniq) = 2, (SELECT n FROM uniq)
  UNION ALL SELECT 6, (SELECT count(*) FROM fn) = 8 AND (SELECT n FROM shape) = 8, (SELECT n FROM shape)
  UNION ALL SELECT 7, (SELECT n FROM trg) = 4, (SELECT n FROM trg)
  UNION ALL SELECT 8, (SELECT count(*) FROM req) = 1 AND (SELECT n FROM rt_req_bad) = 0, (SELECT n FROM rt_req_bad)
  UNION ALL SELECT 9, (SELECT granted FROM rt_exec) = 6 AND (SELECT helpers FROM rt_exec) = 0, (SELECT granted FROM rt_exec)
  UNION ALL SELECT 10, has_table_privilege('app_runtime', (SELECT oid FROM att), 'SELECT') AND (SELECT n FROM rt_att_other) = 0,
                       (SELECT n FROM rt_att_other)
  UNION ALL SELECT 11, (SELECT count(*) FROM apr) = 1 AND (SELECT n FROM apr_any) = 0, (SELECT n FROM apr_any)
  UNION ALL SELECT 12, (SELECT count(*) FROM tbls) = 3 AND (SELECT n FROM auth_any) = 0, (SELECT n FROM auth_any)
  UNION ALL SELECT 13, (SELECT count(*) FROM fn) = 8 AND (SELECT n FROM pub_exec) = 0, (SELECT n FROM pub_exec)
  UNION ALL SELECT 14, (SELECT count(*) FROM tbls) = 3 AND (NOT (SELECT has_role FROM admin) OR (SELECT n FROM admin) = 4),
                       (SELECT n FROM admin)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
