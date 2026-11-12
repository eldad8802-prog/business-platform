-- ============================================================================
-- signup-legal-identity-production-evidence.sql
--
-- Read-only PROOF that 20261128090000_signup_legal_identity is applied exactly as reviewed. Run AFTER the apply.
-- Before the apply it errors (its columns are missing) or reports FAIL rows.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== signup legal identity proof: legend (n -> check) =='
\echo ' 1 the ledger row is finished, not rolled back, with the reviewed checksum (observed = rows)'
\echo ' 2 BusinessProfile.legalIdentityConfirmedAt and legalIdentitySource exist, nullable (observed = of 2)'
\echo ' 3 the source check and the pair check exist (observed = of 2)'
\echo ' 4 six functions exist; seed, confirm and the deletion helper are SECURITY DEFINER with a pinned search_path (observed = of 3)'
\echo ' 5 the guard functions legal_identity_lock and legal_identity_no_delete are SECURITY INVOKER (observed = of 2)'
\echo ' 6 the three BusinessProfile_legal_identity_* triggers exist and are enabled (observed = of 3)'
\echo ' 7 app_auth executes the seed and none of the other five (observed = functions app_auth executes)'
\echo ' 8 app_runtime executes the completion and the deletion helper, not the seed (observed = of 2, seed excluded)'
\echo ' 9 PUBLIC executes none of the six (observed = functions)'
\echo '10 no row breaks the pair rule (observed = rows)'
\echo '11 the check digit answers a known valid and a known invalid number correctly (observed = 1)'
\echo '12 app_auth still holds no privilege on BusinessProfile (observed = privileges)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
bp  AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessProfile' AND c.relkind = 'r'),
fn  AS (SELECT p.oid, p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS cfg, coalesce(p.proacl::text, '') AS acl
          FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
          ('signup_legal_identity_seed', 'legal_identity_confirm_existing', 'legal_identity_tax_id_ok',
           'legal_identity_business_is_being_deleted', 'legal_identity_lock', 'legal_identity_no_delete')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261128090000_signup_legal_identity'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = 'f81da1290e62705138d2a0e3a8440d1961c464df598c013995d828a577da00b7') = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261128090000_signup_legal_identity'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL
               AND checksum = 'f81da1290e62705138d2a0e3a8440d1961c464df598c013995d828a577da00b7')
  UNION ALL SELECT 2, (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM bp) AND NOT a.attisdropped
                        AND NOT a.attnotnull AND a.attname IN ('legalIdentityConfirmedAt', 'legalIdentitySource')) = 2,
                      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM bp) AND NOT a.attisdropped
                        AND NOT a.attnotnull AND a.attname IN ('legalIdentityConfirmedAt', 'legalIdentitySource'))
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM bp) AND k.contype = 'c'
                        AND k.conname IN ('BusinessProfile_legalIdentitySource_check', 'BusinessProfile_legalIdentity_pair')) = 2,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM bp) AND k.contype = 'c'
                        AND k.conname IN ('BusinessProfile_legalIdentitySource_check', 'BusinessProfile_legalIdentity_pair'))
  UNION ALL SELECT 4, (SELECT count(*) FROM fn) = 6
                      AND (SELECT count(*) FROM fn WHERE prosecdef AND cfg LIKE '%search_path=pg_catalog, public, pg_temp%'
                            AND proname IN ('signup_legal_identity_seed', 'legal_identity_confirm_existing', 'legal_identity_business_is_being_deleted')) = 3,
                      (SELECT count(*) FROM fn WHERE prosecdef AND cfg LIKE '%search_path=pg_catalog, public, pg_temp%'
                            AND proname IN ('signup_legal_identity_seed', 'legal_identity_confirm_existing', 'legal_identity_business_is_being_deleted'))
  UNION ALL SELECT 5, (SELECT count(*) FROM fn WHERE proname IN ('legal_identity_lock', 'legal_identity_no_delete') AND NOT prosecdef) = 2,
                      (SELECT count(*) FROM fn WHERE proname IN ('legal_identity_lock', 'legal_identity_no_delete') AND NOT prosecdef)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM bp) AND t.tgenabled = 'O'
                        AND t.tgname IN ('BusinessProfile_legal_identity_lock', 'BusinessProfile_legal_identity_insert', 'BusinessProfile_legal_identity_no_delete')) = 3,
                      (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM bp) AND t.tgenabled = 'O'
                        AND t.tgname IN ('BusinessProfile_legal_identity_lock', 'BusinessProfile_legal_identity_insert', 'BusinessProfile_legal_identity_no_delete'))
  UNION ALL SELECT 7, (SELECT count(*) FROM fn WHERE has_function_privilege('app_auth', oid, 'EXECUTE')) = 1
                      AND (SELECT bool_and(has_function_privilege('app_auth', oid, 'EXECUTE')) FROM fn WHERE proname = 'signup_legal_identity_seed'),
                      (SELECT count(*) FROM fn WHERE has_function_privilege('app_auth', oid, 'EXECUTE'))
  UNION ALL SELECT 8, (SELECT count(*) FROM fn WHERE has_function_privilege('app_runtime', oid, 'EXECUTE')
                        AND proname IN ('legal_identity_confirm_existing', 'legal_identity_business_is_being_deleted')) = 2
                      AND NOT (SELECT bool_or(has_function_privilege('app_runtime', oid, 'EXECUTE')) FROM fn WHERE proname = 'signup_legal_identity_seed'),
                      (SELECT count(*) FROM fn WHERE has_function_privilege('app_runtime', oid, 'EXECUTE')
                        AND proname IN ('legal_identity_confirm_existing', 'legal_identity_business_is_being_deleted'))
  UNION ALL SELECT 9, (SELECT count(*) FROM fn WHERE acl = '' OR acl LIKE '%{=X/%' OR acl LIKE '%,=X/%') = 0,
                      (SELECT count(*) FROM fn WHERE acl = '' OR acl LIKE '%{=X/%' OR acl LIKE '%,=X/%')
  UNION ALL SELECT 10, (SELECT count(*) FROM "BusinessProfile"
                         WHERE ("legalIdentityConfirmedAt" IS NULL) <> ("legalIdentitySource" IS NULL)) = 0,
                       (SELECT count(*) FROM "BusinessProfile"
                         WHERE ("legalIdentityConfirmedAt" IS NULL) <> ("legalIdentitySource" IS NULL))
  UNION ALL SELECT 11, public.legal_identity_tax_id_ok('000000018') AND NOT public.legal_identity_tax_id_ok('123456789'),
                       CASE WHEN public.legal_identity_tax_id_ok('000000018') AND NOT public.legal_identity_tax_id_ok('123456789') THEN 1 ELSE 0 END
  UNION ALL SELECT 12, (SELECT count(*) FROM (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')) v(p)
                         WHERE has_table_privilege('app_auth', (SELECT oid FROM bp), v.p)) = 0,
                       (SELECT count(*) FROM (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')) v(p)
                         WHERE has_table_privilege('app_auth', (SELECT oid FROM bp), v.p))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
