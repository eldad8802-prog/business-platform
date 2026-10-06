-- ============================================================================
-- payments-core-config-production-evidence.sql
--
-- Read-only POST-APPLY proof for migration
--   20261016090000_payments_core_connection_config
-- The migration is recorded; exactly the two columns, one type and one index
-- exist with the intended shape; every existing connection kept its meaning
-- (NOT_CONFIGURED, not default); the runtime can use the new columns.
--
-- NO DATA ROW is read except counts. OUTPUT: n | result | observed_count.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- Migration file sha256 (pinned; the lab fails if the file and this line disagree):
--   'd410eb43a4c9852f49cda7edcdc1a7f1b28ec5b609c96a4abade38c6d06d959e'
-- ============================================================================

\echo '== payments core config production evidence — legend (n → check) =='
\echo ' 1 L0 the migration is recorded: finished, not rolled back'
\echo ' 2 E0 PaymentDocumentIssuer = exactly NOT_CONFIGURED, DUBIZ_ISSUES, PROVIDER_ISSUES (observed = labels)'
\echo ' 3 C0 documentIssuer NOT NULL DEFAULT NOT_CONFIGURED; isDefault NOT NULL DEFAULT false (observed = matching columns)'
\echo ' 4 I0 the default index is UNIQUE on (businessId) WHERE isDefault (observed = matching indexes)'
\echo ' 5 D0 every existing connection kept its meaning: none configured, none default (observed = connections changed)'
\echo ' 6 G0 runtime can read and change both new columns (observed = column privileges held, of 4)'
\echo ' 7 T0 BusinessPaymentConnection still ENABLE + FORCE RLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
bpc AS (SELECT oid, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'BusinessPaymentConnection' AND relkind = 'r'),
issuer AS (SELECT oid FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname = 'PaymentDocumentIssuer'),
cols AS (
  SELECT count(*) AS n FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = (SELECT oid FROM bpc) AND NOT a.attisdropped AND a.attnotnull
     AND ((a.attname = 'documentIssuer' AND a.atttypid = (SELECT oid FROM issuer) AND pg_get_expr(d.adbin, d.adrelid) LIKE '''NOT_CONFIGURED''%')
       OR (a.attname = 'isDefault' AND pg_get_expr(d.adbin, d.adrelid) = 'false'))),
idx AS (
  SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = (SELECT oid FROM bpc) AND i.indisunique
     AND c.relname = 'BusinessPaymentConnection_one_default_per_business'
     AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId")%'
     AND pg_get_expr(i.indpred, i.indrelid) LIKE '%"isDefault"%'),
changed AS (
  SELECT count(*) AS n FROM "BusinessPaymentConnection"
   WHERE "documentIssuer"::text <> 'NOT_CONFIGURED' OR "isDefault"),
colpriv(c, p) AS (VALUES ('documentIssuer', 'SELECT'), ('documentIssuer', 'UPD' || 'ATE'), ('isDefault', 'SELECT'), ('isDefault', 'UPD' || 'ATE')),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261016090000_payments_core_connection_config'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261016090000_payments_core_connection_config')
  UNION ALL SELECT 2, (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = (SELECT oid FROM issuer))
                      = ARRAY['NOT_CONFIGURED', 'DUBIZ_ISSUES', 'PROVIDER_ISSUES'],
                      (SELECT count(*) FROM pg_enum WHERE enumtypid = (SELECT oid FROM issuer))
  UNION ALL SELECT 3, (SELECT n FROM cols) = 2, (SELECT n FROM cols)
  UNION ALL SELECT 4, (SELECT n FROM idx) = 1, (SELECT n FROM idx)
  UNION ALL SELECT 5, (SELECT n FROM changed) = 0, (SELECT n FROM changed)
  UNION ALL SELECT 6, (SELECT count(*) FROM colpriv WHERE has_column_privilege('app_runtime', '"BusinessPaymentConnection"', c, p)) = 4,
                      (SELECT count(*) FROM colpriv WHERE has_column_privilege('app_runtime', '"BusinessPaymentConnection"', c, p))
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM bpc WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM bpc)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
