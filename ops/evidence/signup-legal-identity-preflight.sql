-- ============================================================================
-- signup-legal-identity-preflight.sql
--
-- Read-only PREFLIGHT for 20261128090000_signup_legal_identity: the premises it builds on, checked in the target
-- database BEFORE it is applied. Every check must PASS before the release applies it. After it is applied,
-- exactly checks 2, 3, 4 and 5 turn FAIL (they describe "not there yet").
-- Ordering: it sorts after 20261123090000 (#1091) and 20261126090000 (#1105); check 1 refuses if anything that
-- sorts after it is already applied. Released in the same run as those two, Prisma applies them in order.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== signup legal identity preflight: legend (n -> check) =='
\echo ' 1 no finished migration sorts after 20261128090000_signup_legal_identity (observed = rows)'
\echo ' 2 20261128090000 is not in the ledger (observed = rows)'
\echo ' 3 BusinessProfile has neither legalIdentityConfirmedAt nor legalIdentitySource yet (observed = of 2)'
\echo ' 4 none of its five functions exists yet (observed = of 5)'
\echo ' 5 no BusinessProfile_legal_identity_* trigger yet (observed = triggers)'
\echo ' 6 the roles exist: app_auth, app_runtime (observed = of 2)'
\echo ' 7 BusinessProfile is under FORCE row level security (observed = 1 when forced)'
\echo ' 8 app_runtime may modify BusinessProfile rows but may not remove them (observed = 1 when both hold)'
\echo ' 9 the columns it reads and writes exist: BusinessProfile businessId + 6 billing identity columns, Business deletionRequestedAt + deletedAt (observed = of 9)'
\echo '10 the xid8 -> xid cast its "created in this transaction" test uses exists (observed = casts)'
\echo '11 app_auth holds no privilege on BusinessProfile (the seed writes through the definer function) (observed = privileges)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
bp  AS (SELECT c.oid, c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessProfile' AND c.relkind = 'r'),
biz AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
fns AS (SELECT p.oid FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN
         ('signup_legal_identity_seed', 'legal_identity_confirm_existing', 'legal_identity_tax_id_ok',
          'legal_identity_business_is_being_deleted', 'legal_identity_lock')),
trg AS (SELECT t.oid FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM bp) AND t.tgname LIKE 'BusinessProfile\_legal\_identity\_%'),
cols AS (SELECT count(*) AS n FROM pg_attribute a WHERE NOT a.attisdropped AND (
           (a.attrelid = (SELECT oid FROM bp) AND a.attname IN ('businessId', 'billingBusinessKind', 'billingLegalName', 'billingTaxId',
                                                                'billingAddress', 'billingPhone', 'billingEmail'))
        OR (a.attrelid = (SELECT oid FROM biz) AND a.attname IN ('deletionRequestedAt', 'deletedAt')))),
newcols AS (SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM bp) AND NOT a.attisdropped
              AND a.attname IN ('legalIdentityConfirmedAt', 'legalIdentitySource')),
authpriv AS (SELECT count(*) AS n FROM (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')) v(p)
              WHERE has_table_privilege('app_auth', (SELECT oid FROM bp), v.p)),
later AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name > '20261128090000_signup_legal_identity'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
mine AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261128090000_signup_legal_identity'),
xcast AS (SELECT count(*) AS n FROM pg_cast WHERE castsource = 'xid8'::regtype AND casttarget = 'xid'::regtype),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM later) = 0, (SELECT n FROM later)
  UNION ALL SELECT 2, (SELECT n FROM mine) = 0, (SELECT n FROM mine)
  UNION ALL SELECT 3, (SELECT n FROM newcols) = 0, (SELECT n FROM newcols)
  UNION ALL SELECT 4, (SELECT count(*) FROM fns) = 0, (SELECT count(*) FROM fns)
  UNION ALL SELECT 5, (SELECT count(*) FROM trg) = 0, (SELECT count(*) FROM trg)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime')) = 2,
                      (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime'))
  UNION ALL SELECT 7, coalesce((SELECT relforcerowsecurity FROM bp), false), (SELECT count(*) FROM bp WHERE relforcerowsecurity)
  UNION ALL SELECT 8, has_table_privilege('app_runtime', (SELECT oid FROM bp), 'UPD' || 'ATE')
                      AND NOT has_table_privilege('app_runtime', (SELECT oid FROM bp), 'DEL' || 'ETE'),
                      CASE WHEN has_table_privilege('app_runtime', (SELECT oid FROM bp), 'UPD' || 'ATE')
                            AND NOT has_table_privilege('app_runtime', (SELECT oid FROM bp), 'DEL' || 'ETE') THEN 1 ELSE 0 END
  UNION ALL SELECT 9, (SELECT n FROM cols) = 9, (SELECT n FROM cols)
  UNION ALL SELECT 10, (SELECT n FROM xcast) = 1, (SELECT n FROM xcast)
  UNION ALL SELECT 11, (SELECT n FROM authpriv) = 0, (SELECT n FROM authpriv)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
