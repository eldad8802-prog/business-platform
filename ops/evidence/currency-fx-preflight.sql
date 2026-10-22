-- ============================================================================
-- currency-fx-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261025090000_currency_settings_fx_rates   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded, nothing sorting after it was applied first, and
--     20261018090000_daily_tasks_foundation (whose guard task_user_same_business it reuses) is finished;
--   * none of the names it introduces exists: the three tables, the sequence, the indexes, the four functions,
--     the eight policies, the four triggers, the role fx_rate_writer;
--   * what it builds on is there: "Business", "User", and the thirteen financial tables the base-currency
--     guard reads, each with a businessId column and a foreign key to "Business" (that key is what makes the
--     guard race-safe: every financial row taken FOR KEY SHARE of its business);
--   * the migration role owns all of them and carries BYPASSRLS (the guard functions run as it over FORCE RLS
--     tables, and refuse to run without it) and CREATEROLE (it creates fx_rate_writer);
--   * app_runtime is a NOLOGIN NOSUPERUSER NOBYPASSRLS group;
--   * INFO: default-privilege entries of the migration role for new tables in public (taken back by the
--     migration); whether PUBLIC holds USAGE on schema public (the future writer login needs it); how many
--     businesses already hold a financial row (= whose base currency is fixed at ILS from day one);
--   * the server is PostgreSQL 15+.
--
-- Checks 1 and 2 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== currency settings + fx rates preflight: legend (n -> check) =='
\echo ' 1 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo ' 2 V2 row level security is not active on "BillingDocument" for the evidence role (runs first)'
\echo ' 3 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 4 20261025090000_currency_settings_fx_rates is not recorded (observed = rows)'
\echo ' 5 no recorded migration sorts after it (observed = such rows)'
\echo ' 6 20261018090000_daily_tasks_foundation is recorded and finished (observed = rows)'
\echo ' 7 no relation named BusinessLocaleSettings, UserLocalePreference, FxRate, FxRate_id_seq or any of their keys and indexes (observed = present)'
\echo ' 8 none of the four functions, eight policies or four triggers exists (observed = present)'
\echo ' 9 no role named fx_rate_writer (observed = roles)'
\echo '10 Business and User exist, and the 13 financial tables exist each with an integer businessId (observed = of 15)'
\echo '11 each of the 13 financial tables has a foreign key (businessId) to Business (observed = of 13)'
\echo '12 task_user_same_business exists, is not a definer function, and is owned by the migration role (observed = matching)'
\echo '13 the migration role owns Business, User and the 13 financial tables (observed = of 15)'
\echo '14 the migration role carries BYPASSRLS (observed = 1 if so)'
\echo '15 the migration role carries CREATEROLE or is a superuser (observed = 1 if so)'
\echo '16 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS (observed = matching)'
\echo '17 INFO default-privilege entries of the migration role for new tables in public (observed = entries)'
\echo '18 INFO PUBLIC holds USAGE on schema public (observed = 1 if so)'
\echo '19 INFO businesses that already hold a financial row (observed = businesses)'
\echo '20 the server is PostgreSQL 15 or later (observed = major version)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (1, 2) =='
WITH
bd AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'BillingDocument' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, row_security_active((SELECT oid FROM bd)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== preflight checks (3-20) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.relname AS nm, c.oid, c.relowner, c.relkind FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid, rolbypassrls, rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user),
fin(nm) AS (VALUES ('BillingDocument'), ('FinancialRecord'), ('FinancialEvent'), ('HistoricalFiscalDocument'),
                   ('PaymentRequest'), ('Payment'), ('Cheque'), ('PaymentPreparation'), ('ExternalTransaction'),
                   ('OutboundExecution'), ('BusinessObligation'), ('Commitment'), ('CommerceOrder')),
base(nm) AS (SELECT nm FROM fin UNION ALL VALUES ('Business'), ('User')),
new_rels(nm) AS (VALUES ('BusinessLocaleSettings'), ('UserLocalePreference'), ('FxRate'), ('FxRate_id_seq'),
                        ('BusinessLocaleSettings_pkey'), ('UserLocalePreference_pkey'), ('FxRate_pkey'),
                        ('UserLocalePreference_businessId_idx'), ('FxRate_base_quote_kind_source_rateDate_fetchedAt_key'),
                        ('FxRate_base_quote_kind_rateDate_fetchedAt_idx')),
new_fns(nm) AS (VALUES ('business_financial_data_exists'), ('business_locale_base_currency_lock'),
                       ('business_base_currency_locked'), ('fx_rate_append_only_guard')),
new_pols(nm) AS (VALUES ('business_locale_settings_tenant_select'), ('business_locale_settings_tenant_insert'),
                        ('business_locale_settings_tenant_update'), ('user_locale_preference_own_select'),
                        ('user_locale_preference_own_insert'), ('user_locale_preference_own_update'),
                        ('fx_rate_read'), ('fx_rate_append')),
new_trg(nm) AS (VALUES ('BusinessLocaleSettings_base_currency_lock'), ('UserLocalePreference_user_same_business'),
                       ('FxRate_append_only'), ('FxRate_no_truncate')),
fin_cols AS (SELECT f.nm FROM fin f JOIN rel r ON r.nm = f.nm AND r.relkind = 'r'
             JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = 'businessId' AND NOT a.attisdropped
             WHERE a.atttypid = 'int4'::regtype),
fin_fk AS (SELECT DISTINCT f.nm FROM fin f JOIN rel r ON r.nm = f.nm
           JOIN pg_constraint k ON k.conrelid = r.oid AND k.contype = 'f'
           WHERE k.confrelid = (SELECT oid FROM rel WHERE nm = 'Business' AND relkind = 'r')
             AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attname = 'businessId')]::int2[]),
checks(n, ok, observed_count) AS (
  SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates')
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261025090000_currency_settings_fx_rates') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261025090000_currency_settings_fx_rates')
  UNION ALL SELECT 6, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 7, (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm) = 0,
                      (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm)
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc p JOIN new_fns x ON x.nm = p.proname)
                      + (SELECT count(*) FROM pg_policy p JOIN new_pols x ON x.nm = p.polname)
                      + (SELECT count(*) FROM pg_trigger t JOIN new_trg x ON x.nm = t.tgname) = 0,
                      (SELECT count(*) FROM pg_proc p JOIN new_fns x ON x.nm = p.proname)
                      + (SELECT count(*) FROM pg_policy p JOIN new_pols x ON x.nm = p.polname)
                      + (SELECT count(*) FROM pg_trigger t JOIN new_trg x ON x.nm = t.tgname)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_roles WHERE rolname = 'fx_rate_writer') = 0,
                      (SELECT count(*) FROM pg_roles WHERE rolname = 'fx_rate_writer')
  UNION ALL SELECT 10, (SELECT count(*) FROM fin_cols) + (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User') AND relkind = 'r') = 15,
                       (SELECT count(*) FROM fin_cols) + (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User') AND relkind = 'r')
  UNION ALL SELECT 11, (SELECT count(*) FROM fin_fk) = 13, (SELECT count(*) FROM fin_fk)
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_proc p WHERE p.proname = 'task_user_same_business'
                         AND p.pronamespace = (SELECT oid FROM pub) AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me)) = 1,
                       (SELECT count(*) FROM pg_proc p WHERE p.proname = 'task_user_same_business'
                         AND p.pronamespace = (SELECT oid FROM pub) AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me))
  UNION ALL SELECT 13, (SELECT count(*) FROM rel r JOIN base b ON b.nm = r.nm WHERE r.relkind = 'r' AND r.relowner = (SELECT oid FROM me)) = 15,
                       (SELECT count(*) FROM rel r JOIN base b ON b.nm = r.nm WHERE r.relkind = 'r' AND r.relowner = (SELECT oid FROM me))
  UNION ALL SELECT 14, (SELECT rolbypassrls FROM me) IS TRUE, (SELECT CASE WHEN rolbypassrls THEN 1 ELSE 0 END FROM me)
  UNION ALL SELECT 15, (SELECT rolcreaterole OR rolsuper FROM me) IS TRUE, (SELECT CASE WHEN rolcreaterole OR rolsuper THEN 1 ELSE 0 END FROM me)
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) = 1,
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 17, true, (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                               WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'r'
                                 AND (d.defaclnamespace = 0 OR d.defaclnamespace = (SELECT oid FROM pub)))
  UNION ALL SELECT 18, true, (SELECT count(*) FROM pg_namespace s CROSS JOIN LATERAL aclexplode(s.nspacl) x
                               WHERE s.nspname = 'public' AND x.grantee = 0 AND x.privilege_type = 'USAGE')
  UNION ALL SELECT 19, true, (SELECT count(*) FROM "Business" b WHERE
                                  EXISTS (SELECT 1 FROM "BillingDocument" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "FinancialRecord" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "FinancialEvent" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "HistoricalFiscalDocument" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "PaymentRequest" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "Payment" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "Cheque" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "PaymentPreparation" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "ExternalTransaction" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "OutboundExecution" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "BusinessObligation" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "Commitment" t WHERE t."businessId" = b."id")
                               OR EXISTS (SELECT 1 FROM "CommerceOrder" t WHERE t."businessId" = b."id"))
  UNION ALL SELECT 20, current_setting('server_version_num')::int >= 150000, current_setting('server_version_num')::int / 10000
)
SELECT n, CASE WHEN n IN (17, 18, 19) THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
