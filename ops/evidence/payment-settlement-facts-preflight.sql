-- ============================================================================
-- payment-settlement-facts-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261026090000_payment_settlement_facts   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded, nothing sorting after it was applied first, and
--     20261018090000_daily_tasks_foundation (whose guard task_user_same_business it reuses) is finished;
--   * none of the names it introduces exists: the table, its sequence, keys and indexes, the three functions,
--     the two policies, the five triggers;
--   * what it builds on is there with the shape it relies on: "Business", "User", "PaymentRequest" (integer
--     businessId), "PaymentTransaction" (paymentRequestId, amount numeric(18,2), currency, status) and
--     "ExternalTransaction" (businessId, currency), the three payment tables under FORCE RLS with tenant
--     policies (the guard runs as the writer and relies on the runtime not seeing another business's rows);
--   * the migration role owns all five (it adds foreign keys to them);
--   * app_runtime is a NOLOGIN NOSUPERUSER NOBYPASSRLS group that can read the twelve columns the fact guard, the
--     same-business user guard and the tenant policies read as the writer (column or table privilege; without
--     them every runtime write of a fact would fail);
--   * INFO: default-privilege entries of the migration role for new tables in public (taken back by the
--     migration); payment transactions in total / in a foreign currency / reversals (counts only);
--   * the server is PostgreSQL 15+.
--
-- Checks 1 and 2 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== payment settlement facts preflight: legend (n -> check) =='
\echo ' 1 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo ' 2 V2 row level security is not active on "PaymentTransaction" for the evidence role (runs first)'
\echo ' 3 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 4 20261026090000_payment_settlement_facts is not recorded (observed = rows)'
\echo ' 5 no recorded migration sorts after it (observed = such rows)'
\echo ' 6 20261018090000_daily_tasks_foundation is recorded and finished (observed = rows)'
\echo ' 7 no relation named PaymentSettlementFact, its sequence, or any of its keys and indexes (observed = present)'
\echo ' 8 none of the three functions, two policies or five triggers exists (observed = present)'
\echo ' 9 the five base tables exist with the columns the migration relies on (observed = matching columns, of 10)'
\echo '10 PaymentRequest, PaymentTransaction, ExternalTransaction: RLS ENABLED + FORCED with a tenant policy (observed = of 3)'
\echo '11 task_user_same_business exists, is not a definer function, and is owned by the migration role (observed = matching)'
\echo '12 the migration role owns Business, User, PaymentRequest, PaymentTransaction, ExternalTransaction (observed = of 5)'
\echo '13 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS (observed = matching)'
\echo '14 app_runtime may read the 12 columns the guards read: PaymentTransaction id, paymentRequestId, amount, currency, status; PaymentRequest id, businessId; ExternalTransaction id, businessId, currency; User id, businessId (observed = of 12)'
\echo '15 INFO default-privilege entries of the migration role for new tables in public (observed = entries)'
\echo '16 INFO payment transactions in total (observed = rows)'
\echo '17 INFO payment transactions in a currency other than ILS (observed = rows)'
\echo '18 INFO reversals: payment transactions with a negative amount (observed = rows)'
\echo '19 the server is PostgreSQL 15 or later (observed = major version)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (1, 2) =='
WITH
pt AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'PaymentTransaction' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, row_security_active((SELECT oid FROM pt)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== preflight checks (3-19) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.relname AS nm, c.oid, c.relowner, c.relkind, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
base(nm) AS (VALUES ('Business'), ('User'), ('PaymentRequest'), ('PaymentTransaction'), ('ExternalTransaction')),
rls_tables(nm) AS (VALUES ('PaymentRequest'), ('PaymentTransaction'), ('ExternalTransaction')),
read_cols(tbl, col) AS (VALUES ('PaymentTransaction', 'id'), ('PaymentTransaction', 'paymentRequestId'),
  ('PaymentTransaction', 'amount'), ('PaymentTransaction', 'currency'), ('PaymentTransaction', 'status'),
  ('PaymentRequest', 'id'), ('PaymentRequest', 'businessId'), ('ExternalTransaction', 'id'),
  ('ExternalTransaction', 'businessId'), ('ExternalTransaction', 'currency'), ('User', 'id'), ('User', 'businessId')),
need_cols(tbl, col, typ) AS (VALUES
  ('PaymentRequest', 'id', 'integer'), ('PaymentRequest', 'businessId', 'integer'),
  ('PaymentTransaction', 'id', 'integer'), ('PaymentTransaction', 'paymentRequestId', 'integer'),
  ('PaymentTransaction', 'amount', 'numeric(18,2)'), ('PaymentTransaction', 'currency', 'text'),
  ('PaymentTransaction', 'status', '"PaymentTransactionStatus"'),
  ('ExternalTransaction', 'id', 'integer'), ('ExternalTransaction', 'businessId', 'integer'),
  ('ExternalTransaction', 'currency', 'text')),
new_rels(nm) AS (VALUES ('PaymentSettlementFact'), ('PaymentSettlementFact_id_seq'), ('PaymentSettlementFact_pkey'),
  ('PaymentSettlementFact_first_version_key'), ('PaymentSettlementFact_supersedesId_key'),
  ('PaymentSettlementFact_businessId_idempotencyKey_key'), ('PaymentSettlementFact_businessId_paymentTransactionId_idx'),
  ('PaymentSettlementFact_businessId_kind_currency_idx'), ('PaymentSettlementFact_businessId_review_idx'),
  ('PaymentSettlementFact_externalTransactionId_idx')),
new_fns(nm) AS (VALUES ('payment_settlement_fact_guard'), ('payment_settlement_fact_net_check'),
  ('payment_settlement_fact_append_only')),
new_pols(nm) AS (VALUES ('payment_settlement_fact_tenant_select'), ('payment_settlement_fact_tenant_insert')),
new_trgs(nm) AS (VALUES ('PaymentSettlementFact_guard'), ('PaymentSettlementFact_user_same_business'),
  ('PaymentSettlementFact_net_check'), ('PaymentSettlementFact_append_only'), ('PaymentSettlementFact_no_truncate')),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
checks(n, ok, observed_count) AS (
  SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts')
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261026090000_payment_settlement_facts') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261026090000_payment_settlement_facts')
  UNION ALL SELECT 6, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 7, (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm) = 0,
                      (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm)
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc p JOIN new_fns x ON x.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub))
                      + (SELECT count(*) FROM pg_policy p JOIN new_pols x ON x.nm = p.polname)
                      + (SELECT count(*) FROM pg_trigger t JOIN new_trgs x ON x.nm = t.tgname) = 0,
                      (SELECT count(*) FROM pg_proc p JOIN new_fns x ON x.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub))
                      + (SELECT count(*) FROM pg_policy p JOIN new_pols x ON x.nm = p.polname)
                      + (SELECT count(*) FROM pg_trigger t JOIN new_trgs x ON x.nm = t.tgname)
  UNION ALL SELECT 9, (SELECT count(*) FROM base b JOIN rel r ON r.nm = b.nm AND r.relkind = 'r') = 5
                      AND (SELECT count(*) FROM need_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid
                             AND a.attname = c.col AND NOT a.attisdropped AND a.attnotnull
                           WHERE format_type(a.atttypid, a.atttypmod) = c.typ) = 10,
                      (SELECT count(*) FROM need_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid
                         AND a.attname = c.col AND NOT a.attisdropped AND a.attnotnull
                       WHERE format_type(a.atttypid, a.atttypmod) = c.typ)
  UNION ALL SELECT 10, (SELECT count(*) FROM rls_tables t JOIN rel r ON r.nm = t.nm
                         WHERE r.relrowsecurity AND r.relforcerowsecurity
                           AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid
                                         AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%app.current_business_id%')) = 3,
                       (SELECT count(*) FROM rls_tables t JOIN rel r ON r.nm = t.nm
                         WHERE r.relrowsecurity AND r.relforcerowsecurity
                           AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid
                                         AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%app.current_business_id%'))
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                          AND p.proname = 'task_user_same_business' AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me)) = 1,
                       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                          AND p.proname = 'task_user_same_business' AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me))
  UNION ALL SELECT 12, (SELECT count(*) FROM base b JOIN rel r ON r.nm = b.nm WHERE r.relowner = (SELECT oid FROM me)) = 5,
                       (SELECT count(*) FROM base b JOIN rel r ON r.nm = b.nm WHERE r.relowner = (SELECT oid FROM me))
  UNION ALL SELECT 13, (SELECT count(*) FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) = 1,
                       (SELECT count(*) FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 14, (SELECT count(*) FROM read_cols c JOIN rel r ON r.nm = c.tbl
                         WHERE EXISTS (SELECT 1 FROM rt) AND has_column_privilege((SELECT oid FROM rt), r.oid, c.col, 'SELECT')) = 12,
                       (SELECT count(*) FROM read_cols c JOIN rel r ON r.nm = c.tbl
                         WHERE EXISTS (SELECT 1 FROM rt) AND has_column_privilege((SELECT oid FROM rt), r.oid, c.col, 'SELECT'))
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM pg_default_acl d WHERE d.defaclrole = (SELECT oid FROM me)
                                AND d.defaclobjtype = 'r' AND (d.defaclnamespace = 0 OR d.defaclnamespace = (SELECT oid FROM pub)))
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM "PaymentTransaction")
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM "PaymentTransaction" WHERE "currency" <> 'ILS')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM "PaymentTransaction" WHERE "amount" < 0)
  UNION ALL SELECT 19, current_setting('server_version_num')::int >= 150000, current_setting('server_version_num')::int / 10000
)
SELECT n, CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
