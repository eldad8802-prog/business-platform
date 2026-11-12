-- ============================================================================
-- legal-identity-correction-preflight.sql
--
-- Read-only PREFLIGHT for 20261128100000_legal_identity_correction: the premises it builds on, checked in the
-- target database BEFORE it is applied. Every check must PASS before the release applies it. After it is applied,
-- exactly checks 2, 4 and 5 turn FAIL (they describe "not there yet").
-- It needs 20261128090000_signup_legal_identity applied first (check 1): it calls that migration's two helpers and
-- reads its confirmation column. Released in the same run, Prisma applies them in order.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== legal identity correction preflight: legend (n -> check) =='
\echo ' 1 20261128090000_signup_legal_identity is finished (observed = finished rows)'
\echo ' 2 20261128100000 is not in the ledger (observed = rows)'
\echo ' 3 the ledger is clean: no unfinished and no rolled-back migration (observed = such rows)'
\echo ' 4 LegalIdentityCorrectionRequest is absent (observed = tables)'
\echo ' 5 none of its five functions exists yet (observed = of 5)'
\echo ' 6 the roles exist: app_auth, app_runtime (observed = of 2)'
\echo ' 7 the helpers it calls exist: legal_identity_tax_id_ok, legal_identity_business_is_being_deleted (observed = of 2)'
\echo ' 8 the columns it reads exist: User.role, User.businessId, BusinessProfile.legalIdentityConfirmedAt (observed = of 3)'
\echo ' 9 UserRole has the value PLATFORM_ADMIN (the approver check) (observed = values)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
bp  AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessProfile' AND c.relkind = 'r'),
tbl AS (SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'LegalIdentityCorrectionRequest'),
fns AS (SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
         ('legal_identity_correction_guard', 'legal_identity_correction_request', 'legal_identity_correction_cancel',
          'legal_identity_correction_decide', 'legal_identity_correction_erase')),
helpers AS (SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
              AND p.proname IN ('legal_identity_tax_id_ok', 'legal_identity_business_is_being_deleted')),
cols AS (SELECT count(*) AS n FROM pg_attribute a WHERE NOT a.attisdropped AND (
           (a.attrelid = (SELECT oid FROM usr) AND a.attname IN ('role', 'businessId'))
        OR (a.attrelid = (SELECT oid FROM bp) AND a.attname = 'legalIdentityConfirmedAt'))),
roleval AS (SELECT count(*) AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = 'UserRole' AND e.enumlabel = 'PLATFORM_ADMIN'),
prev AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128090000_signup_legal_identity'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
mine AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128100000_legal_identity_correction'),
unclean AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM prev) = 1, (SELECT n FROM prev)
  UNION ALL SELECT 2, (SELECT n FROM mine) = 0, (SELECT n FROM mine)
  UNION ALL SELECT 3, (SELECT n FROM unclean) = 0, (SELECT n FROM unclean)
  UNION ALL SELECT 4, (SELECT n FROM tbl) = 0, (SELECT n FROM tbl)
  UNION ALL SELECT 5, (SELECT n FROM fns) = 0, (SELECT n FROM fns)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime')) = 2,
                      (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime'))
  UNION ALL SELECT 7, (SELECT n FROM helpers) = 2, (SELECT n FROM helpers)
  UNION ALL SELECT 8, (SELECT n FROM cols) = 3, (SELECT n FROM cols)
  UNION ALL SELECT 9, (SELECT n FROM roleval) = 1, (SELECT n FROM roleval)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
