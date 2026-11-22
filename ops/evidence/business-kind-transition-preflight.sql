-- ============================================================================
-- business-kind-transition-preflight.sql
--
-- Read-only PREFLIGHT for 20261221090000_business_kind_transition: the premises it builds on, checked in the target
-- database BEFORE it is applied. Every check must PASS before the release applies it. After it is applied, exactly
-- checks 2, 3 and 4 turn FAIL (they describe "not there yet").
-- Ordering: it depends on 20261126100000 and 20261128090000 (both applied in Production) and on no pending migration.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== business kind transition preflight: legend (n -> check) =='
\echo ' 1 the ledger is clean: no unfinished or rolled-back migration row (observed = rows)'
\echo ' 2 20261221090000 is not in the ledger (observed = rows)'
\echo ' 3 table BusinessKindTransition is absent (observed = tables)'
\echo ' 4 none of its three functions exists yet (observed = of 3)'
\echo ' 5 the role app_runtime exists (observed = roles)'
\echo ' 6 the two helpers it calls exist: legal_identity_tax_id_ok, legal_identity_business_is_being_deleted (observed = of 2)'
\echo ' 7 its two prerequisites are finished in the ledger: 20261126100000, 20261128090000 (observed = of 2)'
\echo ' 8 the columns it reads exist: BusinessProfile 6, BusinessIssuerDeclaration 3, User 1 (observed = of 10)'
\echo ' 9 the signup identity trigger on BusinessProfile exists (observed = triggers)'
\echo '10 the time zone Asia/Jerusalem is known to the server (observed = rows)'
\echo '11 the sha256(bytea) function exists (observed = functions)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(name) AS (VALUES ('BusinessProfile'), ('BusinessIssuerDeclaration'), ('User')),
rels AS (SELECT c.oid, c.relname FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
           AND c.relname IN (SELECT name FROM rel)),
newtab AS (SELECT count(*) AS n FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessKindTransition'),
fns AS (SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
         ('business_kind_transition_append_only', 'business_kind_transition_statement', 'business_kind_transition_to_authorized')),
helpers AS (SELECT count(DISTINCT p.proname) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
         ('legal_identity_tax_id_ok', 'legal_identity_business_is_being_deleted')),
prereq AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND migration_name IN ('20261126100000_issuer_declaration', '20261128090000_signup_legal_identity')),
cols AS (SELECT count(*) AS n FROM pg_attribute a JOIN rels r ON r.oid = a.attrelid WHERE NOT a.attisdropped AND (
           (r.relname = 'BusinessProfile' AND a.attname IN ('businessId', 'billingBusinessKind', 'billingLegalName', 'billingTaxId',
                                                           'billingVatNumber', 'updatedAt'))
        OR (r.relname = 'BusinessIssuerDeclaration' AND a.attname IN ('businessId', 'version', 'anonymisedAt'))
        OR (r.relname = 'User' AND a.attname = 'businessId'))),
trg AS (SELECT count(*) AS n FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid
          WHERE r.relname = 'BusinessProfile' AND t.tgname = 'BusinessProfile_legal_identity_lock'),
later AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
mine AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261221090000_business_kind_transition'),
tz AS (SELECT count(*) AS n FROM pg_timezone_names WHERE name = 'Asia/Jerusalem'),
sha AS (SELECT count(*) AS n FROM pg_proc WHERE proname = 'sha256' AND pronamespace = 'pg_catalog'::regnamespace),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM later) = 0, (SELECT n FROM later)
  UNION ALL SELECT 2, (SELECT n FROM mine) = 0, (SELECT n FROM mine)
  UNION ALL SELECT 3, (SELECT n FROM newtab) = 0, (SELECT n FROM newtab)
  UNION ALL SELECT 4, (SELECT n FROM fns) = 0, (SELECT n FROM fns)
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 1, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 6, (SELECT n FROM helpers) = 2, (SELECT n FROM helpers)
  UNION ALL SELECT 7, (SELECT n FROM prereq) = 2, (SELECT n FROM prereq)
  UNION ALL SELECT 8, (SELECT n FROM cols) = 10, (SELECT n FROM cols)
  UNION ALL SELECT 9, (SELECT n FROM trg) = 1, (SELECT n FROM trg)
  UNION ALL SELECT 10, (SELECT n FROM tz) = 1, (SELECT n FROM tz)
  UNION ALL SELECT 11, (SELECT n FROM sha) >= 1, (SELECT n FROM sha)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
