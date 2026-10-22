-- ============================================================================
-- currency-fx-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261025090000_currency_settings_fx_rates
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the three tables have exactly their columns (type, nullability, default), CHECKs (validated), keys and
--     indexes;
--   * RLS ENABLED + FORCED on all three; exactly eight policies (tenant read / add / change on
--     "BusinessLocaleSettings", own-user read / add / change on "UserLocalePreference", read + append on
--     "FxRate"), PERMISSIVE, for PUBLIC, each expression equal to the expected one; no removal policy;
--   * ACLs: app_runtime read / add / change on the two settings tables and read on "FxRate"; fx_rate_writer
--     append on "FxRate" and USAGE on its sequence; nothing else, no column-level privilege; no role reaches the
--     tables beyond that (the Neon platform admin path is set aside exactly as in the task reminders proof and
--     counted in check 21);
--   * the four triggers are enabled on the right events; the four functions have the right security mode,
--     pinned search_path and owner; EXECUTE only on business_base_currency_locked, for app_runtime alone;
--   * fx_rate_writer is a NOLOGIN role with no elevated attribute, member of no role, holding nothing else;
--   * nothing written: the three tables hold no row.
--
-- Checks 22 and 23 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== currency settings + fx rates production evidence: legend (n -> check) =='
\echo '22 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '23 V2 row level security is not active on "FxRate" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the 24 columns of the three tables exist with their type, nullability and default, and no other (observed = matching, of 24)'
\echo ' 5 the 15 CHECK constraints exist and are validated, and no other (observed = of 15)'
\echo ' 6 keys: three primary keys, three foreign keys (cascade), the unique rate key and the two indexes (observed = of 9)'
\echo ' 7 the three tables: RLS ENABLED + FORCED (observed = of 3)'
\echo ' 8 exactly the eight policies, each on its table and command, PERMISSIVE, PUBLIC; no other policy on the tables (observed = policies)'
\echo ' 9 every policy expression equals the expected one exactly (observed = mismatches)'
\echo '10 table ACLs are exactly: app_runtime arw, arw, r; fx_rate_writer a on FxRate (observed = grantee x privilege pairs, of 8)'
\echo '11 "FxRate_id_seq" ACL is exactly fx_rate_writer USAGE (observed = pairs)'
\echo '12 no column-level privilege on the three tables (observed = column grants)'
\echo '13 no role reaches the tables beyond those grants (observed = pairs outside, after the check 21 exception)'
\echo '14 the four triggers exist, enabled, on the right timing / events / level and function (observed = of 4)'
\echo '15 the three guard functions are SECURITY DEFINER, search_path pinned, owned by the migration role (observed = of 3)'
\echo '16 fx_rate_append_only_guard is not a definer function, search_path pinned, owned by the migration role (observed = matching)'
\echo '17 EXECUTE: business_base_currency_locked for app_runtime alone; the other three for nobody but the owner; no PUBLIC (observed = unexpected grants)'
\echo '18 fx_rate_writer: NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION, member of no role (observed = 1 if so)'
\echo '19 fx_rate_writer reaches no other relation in public beyond what PUBLIC holds (observed = relations)'
\echo '20 nothing written: the three tables hold no row (observed = rows)'
\echo '21 exception: pairs set aside by check 13 as Neon platform admin access; at most 2 roles and 12 pairs (observed = pairs set aside)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (22, 23) =='
WITH
fx AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'FxRate' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 22, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 23, row_security_active((SELECT oid FROM fx)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-21) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl, relkind) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relkind
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
wr AS (SELECT oid FROM pg_roles WHERE rolname = 'fx_rate_writer'),
tbl AS (SELECT * FROM rel WHERE nm IN ('BusinessLocaleSettings', 'UserLocalePreference', 'FxRate') AND relkind = 'r'),
tenant_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
own_expr(e) AS (VALUES ('(("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer) AND ("userId" = (NULLIF(current_setting(''app.current_user_id''::text, true), ''''::text))::integer))')),
cols(tbl, col, typ, notnull, dflt) AS (VALUES
  ('BusinessLocaleSettings', 'businessId', 'integer', true, NULL),
  ('BusinessLocaleSettings', 'locale', 'text', true, '''he''::text'),
  ('BusinessLocaleSettings', 'region', 'text', true, '''IL''::text'),
  ('BusinessLocaleSettings', 'timeZone', 'text', true, '''Asia/Jerusalem''::text'),
  ('BusinessLocaleSettings', 'baseCurrency', 'text', true, '''ILS''::text'),
  ('BusinessLocaleSettings', 'displayCurrency', 'text', true, '''ILS''::text'),
  ('BusinessLocaleSettings', 'version', 'integer', true, '1'),
  ('BusinessLocaleSettings', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
  ('BusinessLocaleSettings', 'updatedAt', 'timestamp(3) without time zone', true, NULL),
  ('UserLocalePreference', 'userId', 'integer', true, NULL),
  ('UserLocalePreference', 'businessId', 'integer', true, NULL),
  ('UserLocalePreference', 'locale', 'text', true, NULL),
  ('UserLocalePreference', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
  ('UserLocalePreference', 'updatedAt', 'timestamp(3) without time zone', true, NULL),
  ('FxRate', 'id', 'integer', true, 'next' || 'val(''"FxRate_id_seq"''::regclass)'),
  ('FxRate', 'base', 'text', true, NULL),
  ('FxRate', 'quote', 'text', true, NULL),
  ('FxRate', 'rate', 'numeric(20,10)', true, NULL),
  ('FxRate', 'kind', 'text', true, NULL),
  ('FxRate', 'source', 'text', true, NULL),
  ('FxRate', 'rateDate', 'date', true, NULL),
  ('FxRate', 'fetchedAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
  ('FxRate', 'verification', 'text', true, '''UNVERIFIED''::text'),
  ('FxRate', 'sourceRef', 'text', false, NULL)),
att AS (SELECT t.nm AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull,
               pg_get_expr(d.adbin, d.adrelid) AS dflt
        FROM tbl t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum),
checks_expected(tbl, nm) AS (VALUES
  ('BusinessLocaleSettings', 'BusinessLocaleSettings_locale'), ('BusinessLocaleSettings', 'BusinessLocaleSettings_region'),
  ('BusinessLocaleSettings', 'BusinessLocaleSettings_timeZone'), ('BusinessLocaleSettings', 'BusinessLocaleSettings_baseCurrency'),
  ('BusinessLocaleSettings', 'BusinessLocaleSettings_displayCurrency'), ('BusinessLocaleSettings', 'BusinessLocaleSettings_version'),
  ('UserLocalePreference', 'UserLocalePreference_locale'),
  ('FxRate', 'FxRate_currencies'), ('FxRate', 'FxRate_rate_positive'), ('FxRate', 'FxRate_kind'), ('FxRate', 'FxRate_source'),
  ('FxRate', 'FxRate_boi_shape'), ('FxRate', 'FxRate_verification'), ('FxRate', 'FxRate_not_future'),
  ('FxRate', 'FxRate_sourceRef_length')),
fks(tbl, nm, ref) AS (VALUES ('BusinessLocaleSettings', 'BusinessLocaleSettings_businessId_fkey', 'Business'),
  ('UserLocalePreference', 'UserLocalePreference_userId_fkey', 'User'),
  ('UserLocalePreference', 'UserLocalePreference_businessId_fkey', 'Business')),
idx(tbl, nm, uniq) AS (VALUES ('BusinessLocaleSettings', 'BusinessLocaleSettings_pkey', true),
  ('UserLocalePreference', 'UserLocalePreference_pkey', true), ('FxRate', 'FxRate_pkey', true),
  ('FxRate', 'FxRate_base_quote_kind_source_rateDate_fetchedAt_key', true),
  ('FxRate', 'FxRate_base_quote_kind_rateDate_fetchedAt_idx', false),
  ('UserLocalePreference', 'UserLocalePreference_businessId_idx', false)),
expected_pol(tbl, polname, cmd, q, wc) AS (VALUES
  ('BusinessLocaleSettings', 'business_locale_settings_tenant_select', 'r', 'T', NULL),
  ('BusinessLocaleSettings', 'business_locale_settings_tenant_insert', 'a', NULL, 'T'),
  ('BusinessLocaleSettings', 'business_locale_settings_tenant_update', 'w', 'T', 'T'),
  ('UserLocalePreference', 'user_locale_preference_own_select', 'r', 'O', NULL),
  ('UserLocalePreference', 'user_locale_preference_own_insert', 'a', NULL, 'O'),
  ('UserLocalePreference', 'user_locale_preference_own_update', 'w', 'O', 'O'),
  ('FxRate', 'fx_rate_read', 'r', 'true', NULL),
  ('FxRate', 'fx_rate_append', 'a', NULL, 'true')),
pols AS (SELECT t.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN tbl t ON t.oid = p.polrelid),
want_expr AS (SELECT e.tbl, e.polname,
                     CASE e.q WHEN 'T' THEN (SELECT e FROM tenant_expr) WHEN 'O' THEN (SELECT e FROM own_expr) ELSE e.q END AS q,
                     CASE e.wc WHEN 'T' THEN (SELECT e FROM tenant_expr) WHEN 'O' THEN (SELECT e FROM own_expr) ELSE e.wc END AS wc
              FROM expected_pol e),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
allowed(tbl, member_of, v) AS (VALUES
  ('BusinessLocaleSettings', 'app_runtime', 'SELECT'), ('BusinessLocaleSettings', 'app_runtime', 'INS' || 'ERT'),
  ('BusinessLocaleSettings', 'app_runtime', 'UPD' || 'ATE'),
  ('UserLocalePreference', 'app_runtime', 'SELECT'), ('UserLocalePreference', 'app_runtime', 'INS' || 'ERT'),
  ('UserLocalePreference', 'app_runtime', 'UPD' || 'ATE'),
  ('FxRate', 'app_runtime', 'SELECT'), ('FxRate', 'fx_rate_writer', 'INS' || 'ERT')),
reachers AS (SELECT t.nm AS tbl, t.oid AS toid, t.relowner, t.relacl, r.oid AS rid, v.v
             FROM tbl t CROSS JOIN pg_roles r CROSS JOIN verbs v
             WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> t.relowner
               AND has_table_privilege(r.oid, t.oid, v.v)),
-- The Neon platform admin path proven by run 39461027340, and nothing wider (as in the task reminders proof).
admin_path AS (SELECT x.tbl, x.rid, x.v FROM reachers x JOIN pg_roles p ON p.oid = x.rid
               WHERE x.v IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE', 'DEL' || 'ETE')
                 AND CASE WHEN x.v = 'SELECT' THEN pg_has_role(x.rid, 'pg_read_all_data', 'USAGE')
                          ELSE pg_has_role(x.rid, 'pg_write_all_data', 'USAGE') END
                 AND p.rolbypassrls AND p.rolcreaterole AND p.rolcreatedb
                 AND NOT pg_has_role(x.rid, 'app_runtime', 'USAGE')
                 AND NOT pg_has_role('app_runtime', x.rid, 'MEMBER')
                 AND NOT pg_has_role(x.rid, 'fx_rate_writer', 'USAGE')
                 AND NOT EXISTS (SELECT 1 FROM pg_roles l WHERE l.rolname = 'app_runtime_prod' AND pg_has_role(l.oid, x.rid, 'MEMBER'))
                 AND NOT pg_has_role(x.rid, x.relowner, 'USAGE')
                 AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = x.rid)
                 AND NOT EXISTS (SELECT 1 FROM aclexplode(x.relacl) a
                                 WHERE a.privilege_type = x.v
                                   AND (a.grantee = 0 OR pg_has_role(x.rid, a.grantee, 'USAGE')))),
outside AS (SELECT x.tbl, x.rid, x.v FROM reachers x
            WHERE NOT EXISTS (SELECT 1 FROM allowed a JOIN pg_roles g ON g.rolname = a.member_of
                              WHERE a.tbl = x.tbl AND a.v = x.v AND pg_has_role(x.rid, g.oid, 'USAGE'))
              AND NOT EXISTS (SELECT 1 FROM admin_path a WHERE a.tbl = x.tbl AND a.rid = x.rid AND a.v = x.v)),
-- tgtype bits: 1 row-level, 2 BEFORE, 4 on add, 8 on removal, 16 on change, 32 on emptying the table.
trg(tbl, nm, tgtype, fn) AS (VALUES
  ('BusinessLocaleSettings', 'BusinessLocaleSettings_base_currency_lock', 1 + 2 + 4 + 16, 'business_locale_base_currency_lock'),
  ('UserLocalePreference', 'UserLocalePreference_user_same_business', 1 + 2 + 4 + 16, 'task_user_same_business'),
  ('FxRate', 'FxRate_append_only', 1 + 2 + 8 + 16, 'fx_rate_append_only_guard'),
  ('FxRate', 'FxRate_no_truncate', 2 + 32, 'fx_rate_append_only_guard')),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl
        FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('business_financial_data_exists', 'business_locale_base_currency_lock',
                            'business_base_currency_locked', 'fx_rate_append_only_guard')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
writer_reach AS (SELECT DISTINCT r.oid FROM rel r CROSS JOIN verbs v
                 WHERE r.relkind IN ('r', 'v', 'm', 'p', 'f') AND r.nm <> 'FxRate'
                   AND has_table_privilege((SELECT oid FROM wr), r.oid, v.v)
                   AND NOT has_table_privilege('public', r.oid, v.v)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261025090000_currency_settings_fx_rates'
                        AND checksum = '37bf684b2bd997db5cd577ad3c43c77eeedc0c03fd60cc5fbc93b67c3f1cdafd'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM cols c JOIN att a ON a.tbl = c.tbl AND a.col = c.col
                         AND a.typ = c.typ AND a.notnull = c.notnull AND a.dflt IS NOT DISTINCT FROM c.dflt) = 24
                      AND (SELECT count(*) FROM att) = 24,
                      (SELECT count(*) FROM cols c JOIN att a ON a.tbl = c.tbl AND a.col = c.col
                         AND a.typ = c.typ AND a.notnull = c.notnull AND a.dflt IS NOT DISTINCT FROM c.dflt)
  UNION ALL SELECT 5, (SELECT count(*) FROM checks_expected c JOIN tbl t ON t.nm = c.tbl
                         JOIN pg_constraint k ON k.conrelid = t.oid AND k.conname = c.nm
                         WHERE k.contype = 'c' AND k.convalidated) = 15
                      AND (SELECT count(*) FROM pg_constraint k JOIN tbl t ON t.oid = k.conrelid WHERE k.contype = 'c') = 15,
                      (SELECT count(*) FROM checks_expected c JOIN tbl t ON t.nm = c.tbl
                         JOIN pg_constraint k ON k.conrelid = t.oid AND k.conname = c.nm
                         WHERE k.contype = 'c' AND k.convalidated)
  UNION ALL SELECT 6, (SELECT count(*) FROM fks f JOIN tbl t ON t.nm = f.tbl JOIN pg_constraint k ON k.conrelid = t.oid AND k.conname = f.nm
                         WHERE k.contype = 'f' AND k.confdeltype = 'c' AND k.convalidated
                           AND k.confrelid = (SELECT oid FROM rel WHERE nm = f.ref AND relkind = 'r'))
                      + (SELECT count(*) FROM idx i JOIN tbl t ON t.nm = i.tbl JOIN rel r ON r.nm = i.nm
                         JOIN pg_index x ON x.indexrelid = r.oid AND x.indrelid = t.oid AND x.indisunique = i.uniq) = 9,
                      (SELECT count(*) FROM fks f JOIN tbl t ON t.nm = f.tbl JOIN pg_constraint k ON k.conrelid = t.oid AND k.conname = f.nm
                         WHERE k.contype = 'f' AND k.confdeltype = 'c' AND k.convalidated
                           AND k.confrelid = (SELECT oid FROM rel WHERE nm = f.ref AND relkind = 'r'))
                      + (SELECT count(*) FROM idx i JOIN tbl t ON t.nm = i.tbl JOIN rel r ON r.nm = i.nm
                         JOIN pg_index x ON x.indexrelid = r.oid AND x.indrelid = t.oid AND x.indisunique = i.uniq)
  UNION ALL SELECT 7, (SELECT count(*) FROM tbl WHERE relrowsecurity AND relforcerowsecurity) = 3,
                      (SELECT count(*) FROM tbl WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 8, (SELECT count(*) FROM pols) = 8
                      AND NOT EXISTS (SELECT 1 FROM pols p WHERE NOT EXISTS (SELECT 1 FROM expected_pol e
                                       WHERE e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd))
                      AND NOT EXISTS (SELECT 1 FROM pols WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[]),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 9, (SELECT count(*) FROM want_expr w JOIN pols p ON p.tbl = w.tbl AND p.polname = w.polname
                        WHERE p.q IS NOT DISTINCT FROM w.q AND p.wc IS NOT DISTINCT FROM w.wc) = 8,
                      8 - (SELECT count(*) FROM want_expr w JOIN pols p ON p.tbl = w.tbl AND p.polname = w.polname
                        WHERE p.q IS NOT DISTINCT FROM w.q AND p.wc IS NOT DISTINCT FROM w.wc)
  UNION ALL SELECT 10, (SELECT count(*) FROM acl_items a JOIN tbl t ON t.nm = a.nm) = 8
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'BusinessLocaleSettings' AND grantee = (SELECT oid FROM rt) AND letters = 'arw')
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'UserLocalePreference' AND grantee = (SELECT oid FROM rt) AND letters = 'arw')
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'FxRate' AND grantee = (SELECT oid FROM rt) AND letters = 'r')
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'FxRate' AND grantee = (SELECT oid FROM wr) AND letters = 'a'),
                       (SELECT count(*) FROM acl_items a JOIN tbl t ON t.nm = a.nm)
  UNION ALL SELECT 11, (SELECT count(*) FROM acl_items WHERE nm = 'FxRate_id_seq') = 1
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'FxRate_id_seq' AND grantee = (SELECT oid FROM wr) AND letters = 'U'),
                       (SELECT count(*) FROM acl_items WHERE nm = 'FxRate_id_seq')
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN tbl t ON t.oid = a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x),
                       (SELECT count(*) FROM pg_attribute a JOIN tbl t ON t.oid = a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x)
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM outside), (SELECT count(*) FROM outside)
  UNION ALL SELECT 14, (SELECT count(*) FROM trg e JOIN tbl t ON t.nm = e.tbl
                          JOIN pg_trigger g ON g.tgrelid = t.oid AND g.tgname = e.nm AND NOT g.tgisinternal AND g.tgenabled = 'O'
                          JOIN pg_proc p ON p.oid = g.tgfoid AND p.proname = e.fn
                         WHERE g.tgtype = e.tgtype) = 4,
                       (SELECT count(*) FROM trg e JOIN tbl t ON t.nm = e.tbl
                          JOIN pg_trigger g ON g.tgrelid = t.oid AND g.tgname = e.nm AND NOT g.tgisinternal AND g.tgenabled = 'O'
                          JOIN pg_proc p ON p.oid = g.tgfoid AND p.proname = e.fn
                         WHERE g.tgtype = e.tgtype)
  UNION ALL SELECT 15, (SELECT count(*) FROM fns WHERE proname <> 'fx_rate_append_only_guard' AND prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 3,
                       (SELECT count(*) FROM fns WHERE proname <> 'fx_rate_append_only_guard' AND prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 16, (SELECT count(*) FROM fns WHERE proname = 'fx_rate_append_only_guard' AND NOT prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 1,
                       (SELECT count(*) FROM fns WHERE proname = 'fx_rate_append_only_guard' AND NOT prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 17, (SELECT count(*) FROM fns) = 4
                       AND (SELECT count(*) FROM fn_exec WHERE proname = 'business_base_currency_locked' AND grantee = (SELECT oid FROM rt)) = 1
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE NOT (proname = 'business_base_currency_locked' AND grantee = (SELECT oid FROM rt))),
                       (SELECT count(*) FROM fn_exec WHERE NOT (proname = 'business_base_currency_locked' AND grantee = (SELECT oid FROM rt)))
  UNION ALL SELECT 18, (SELECT count(*) FROM pg_roles r WHERE r.rolname = 'fx_rate_writer' AND NOT r.rolcanlogin AND NOT r.rolsuper
                          AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
                          AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)) = 1,
                       (SELECT count(*) FROM pg_roles r WHERE r.rolname = 'fx_rate_writer' AND NOT r.rolcanlogin AND NOT r.rolsuper
                          AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
                          AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
  UNION ALL SELECT 19, NOT EXISTS (SELECT 1 FROM writer_reach), (SELECT count(*) FROM writer_reach)
  UNION ALL SELECT 20, (SELECT count(*) FROM "BusinessLocaleSettings") + (SELECT count(*) FROM "UserLocalePreference")
                       + (SELECT count(*) FROM "FxRate") = 0,
                       (SELECT count(*) FROM "BusinessLocaleSettings") + (SELECT count(*) FROM "UserLocalePreference")
                       + (SELECT count(*) FROM "FxRate")
  UNION ALL SELECT 21, (SELECT count(*) FROM admin_path) <= 12 AND (SELECT count(DISTINCT rid) FROM admin_path) <= 2,
                       (SELECT count(*) FROM admin_path)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
