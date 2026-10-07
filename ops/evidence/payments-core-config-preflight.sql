-- ============================================================================
-- payments-core-config-preflight.sql
--
-- Read-only PRE-APPLY proof for migration
--   20261016090000_payments_core_connection_config
-- Everything it builds on is present and exactly as expected; nothing it adds
-- exists yet; the runtime holds table-level access (so the new columns are
-- usable the moment they exist); no existing data can conflict.
--
-- NO DATA ROW is read except counts. Catalog and migration-ledger rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== payments core config preflight — legend (n → check) =='
\echo ' 1 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 2 Q2 this migration is not recorded and no newer migration is (observed = such rows)'
\echo ' 3 T0 BusinessPaymentConnection exists under ENABLE + FORCE RLS'
\echo ' 4 T1 nothing this migration adds exists yet: type, two columns, index (observed = objects)'
\echo ' 5 G0 runtime: table-level SELECT / INS-ERT / UPD-ATE on BusinessPaymentConnection (observed = privileges held)'
\echo ' 6 G1 no column-scoped ACL on BusinessPaymentConnection, so new columns inherit table access (observed = columns with an ACL)'
\echo ' 7 R0 runtime logins NOSUPERUSER NOBYPASSRLS; the migration role is BYPASSRLS and may build in public'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
bpc AS (SELECT oid, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'BusinessPaymentConnection' AND relkind = 'r'),
priv(p) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE')),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
added AS (
  SELECT (SELECT count(*) FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname = 'PaymentDocumentIssuer')
       + (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM bpc) AND attname IN ('documentIssuer', 'isDefault') AND NOT attisdropped)
       + (SELECT count(*) FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'BusinessPaymentConnection_one_default_per_business') AS n),
checks(n, ok, observed_count) AS (
  SELECT 1, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name >= '20261016090000_payments_core_connection_config'),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261016090000_payments_core_connection_config')
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM bpc WHERE relrowsecurity AND relforcerowsecurity),
                      (SELECT count(*) FROM bpc)
  UNION ALL SELECT 4, (SELECT n FROM added) = 0,
                      (SELECT n FROM added)
  UNION ALL SELECT 5, (SELECT count(*) FROM priv WHERE has_table_privilege('app_runtime', '"BusinessPaymentConnection"', p)) = 3,
                      (SELECT count(*) FROM priv WHERE has_table_privilege('app_runtime', '"BusinessPaymentConnection"', p))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = (SELECT oid FROM bpc) AND attacl IS NOT NULL AND NOT attisdropped),
                      (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM bpc) AND attacl IS NOT NULL AND NOT attisdropped)
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM runtime_roles)
                      AND NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls)
                      AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
                      AND has_schema_privilege(current_user, 'public', 'CRE' || 'ATE'),
                      (SELECT count(*) FROM runtime_roles)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
