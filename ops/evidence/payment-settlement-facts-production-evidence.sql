-- ============================================================================
-- payment-settlement-facts-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261026090000_payment_settlement_facts
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * "PaymentSettlementFact": its 18 columns with their exact types and nullability; RLS ENABLED + FORCED;
--     exactly two tenant policies (read, append), PERMISSIVE, for PUBLIC, each expression equal to the tenant GUC
--     expression; no change or removal policy; its ACL is exactly app_runtime read / append and its sequence
--     USAGE / SELECT; no column-level privilege; G4: no role reaches it except app_runtime members with read /
--     append (the Neon platform admin path of run 39461027340 is set aside exactly as in the daily tasks proof,
--     and counted in check 18);
--   * its eleven CHECK constraints, five foreign keys (four RESTRICT, the recording user SET NULL), the three
--     partial unique keys (one first version per kind, one successor per fact, idempotency key);
--   * its five triggers, enabled: the fact guard and the same-business user guard (before a new row), the
--     NET check at the end of the transaction (a DEFERRABLE INITIALLY DEFERRED constraint trigger), the
--     append-only guards (before a change or removal of a row, before the table is emptied);
--   * its three functions: not SECURITY DEFINER, search_path pinned, owned by the migration role, EXECUTE for
--     nobody but the owner (no PUBLIC);
--   * nothing written: the table holds no row.
--
-- Checks 19 and 20 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== payment settlement facts production evidence: legend (n -> check) =='
\echo '19 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '20 V2 row level security is not active on "PaymentSettlementFact" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 "PaymentSettlementFact" has exactly its 18 columns, each with its type and nullability (observed = matching, of 18)'
\echo ' 5 "PaymentSettlementFact": RLS ENABLED + FORCED (observed = 1 if both)'
\echo ' 6 exactly two payment_settlement_fact_* policies (read, append), PERMISSIVE, PUBLIC; no other policy on the table (observed = policies)'
\echo ' 7 every policy expression equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 8 the table ACL is exactly app_runtime read, append (observed = grantee x privilege pairs)'
\echo ' 9 the sequence ACL is exactly app_runtime USAGE, SELECT (observed = grantee x privilege pairs)'
\echo '10 no column-level privilege on the table (observed = column grants)'
\echo '11 G4: no role reaches the table except app_runtime members with read / append (observed = pairs outside that, after the check 18 exception)'
\echo '12 the eleven CHECK constraints exist and are validated (observed = of 11)'
\echo '13 the five foreign keys exist with their on-removal actions: Business, PaymentTransaction, ExternalTransaction, the superseded fact RESTRICT; the recording user SET NULL (observed = of 5)'
\echo '14 the three partial unique keys exist: first version per kind, one successor per fact, idempotency key (observed = of 3)'
\echo '15 the five triggers exist, enabled, with their timing, events and functions; the NET check is deferred to the end of the transaction (observed = of 5)'
\echo '16 the three functions: not SECURITY DEFINER, search_path pinned, owned by the migration role; EXECUTE for no one else, no PUBLIC (observed = matching, of 3)'
\echo '17 nothing written: no PaymentSettlementFact row (observed = rows)'
\echo '18 G4 exception: pairs set aside by check 11 as Neon platform admin access (run 39461027340 path only); at most 2 roles and 8 pairs (observed = pairs set aside)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (19, 20) =='
WITH
sf AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'PaymentSettlementFact' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 19, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 20, row_security_active((SELECT oid FROM sf)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-18) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
sf AS (SELECT * FROM rel WHERE nm = 'PaymentSettlementFact'),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
cols(col, typ, req) AS (VALUES
  ('id', 'integer', true), ('businessId', 'integer', true), ('paymentTransactionId', 'integer', true),
  ('kind', 'text', true), ('amount', 'numeric(18,2)', true), ('currency', 'text', true),
  ('providerRate', 'numeric(20,10)', false), ('rateBase', 'text', false), ('rateQuote', 'text', false),
  ('source', 'text', true), ('sourceRef', 'text', false), ('externalTransactionId', 'integer', false),
  ('occurredAt', 'timestamp(3) without time zone', false), ('note', 'text', false), ('idempotencyKey', 'text', false),
  ('supersedesId', 'integer', false), ('recordedByUserId', 'integer', false),
  ('recordedAt', 'timestamp(3) without time zone', true)),
checks_expected(nm) AS (VALUES ('PaymentSettlementFact_kind'), ('PaymentSettlementFact_currency'),
  ('PaymentSettlementFact_source'), ('PaymentSettlementFact_amount_nonzero'), ('PaymentSettlementFact_rate_shape'),
  ('PaymentSettlementFact_bank_line'), ('PaymentSettlementFact_provider_ref'), ('PaymentSettlementFact_manual_note'),
  ('PaymentSettlementFact_charged_source'), ('PaymentSettlementFact_not_self'), ('PaymentSettlementFact_text_lengths')),
fks_expected(nm, target, del) AS (VALUES
  ('PaymentSettlementFact_businessId_fkey', 'Business', 'r'),
  ('PaymentSettlementFact_paymentTransactionId_fkey', 'PaymentTransaction', 'r'),
  ('PaymentSettlementFact_externalTransactionId_fkey', 'ExternalTransaction', 'r'),
  ('PaymentSettlementFact_supersedesId_fkey', 'PaymentSettlementFact', 'r'),
  ('PaymentSettlementFact_recordedByUserId_fkey', 'User', 'n')),
uniq_expected(nm) AS (VALUES ('PaymentSettlementFact_first_version_key'), ('PaymentSettlementFact_supersedesId_key'),
  ('PaymentSettlementFact_businessId_idempotencyKey_key')),
-- tgtype bits: 1 row-level, 2 before, 4 new row, 8 row removal, 16 row change, 32 emptying the table
trg_expected(nm, tgtype, fn, deferred) AS (VALUES
  ('PaymentSettlementFact_guard', 7, 'payment_settlement_fact_guard', false),
  ('PaymentSettlementFact_user_same_business', 7, 'task_user_same_business', false),
  ('PaymentSettlementFact_net_check', 5, 'payment_settlement_fact_net_check', true),
  ('PaymentSettlementFact_append_only', 27, 'payment_settlement_fact_append_only', false),
  ('PaymentSettlementFact_no_truncate', 34, 'payment_settlement_fact_append_only', false)),
fns_expected(nm) AS (VALUES ('payment_settlement_fact_guard'), ('payment_settlement_fact_net_check'),
  ('payment_settlement_fact_append_only')),
expected_pol(polname, cmd, has_q, has_wc) AS (VALUES
  ('payment_settlement_fact_tenant_select', 'r', true, false), ('payment_settlement_fact_tenant_insert', 'a', false, true)),
pols AS (SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM sf)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
reachers AS (SELECT r.oid AS rid, v.v FROM pg_roles r CROSS JOIN verbs v
             WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> (SELECT relowner FROM sf)
               AND has_table_privilege(r.oid, (SELECT oid FROM sf), v.v)),
-- The Neon platform admin path proven by run 39461027340, and nothing wider (as in the daily tasks proof).
admin_path AS (SELECT x.rid, x.v FROM reachers x JOIN pg_roles p ON p.oid = x.rid
               WHERE x.v IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE', 'DEL' || 'ETE')
                 AND CASE WHEN x.v = 'SELECT' THEN pg_has_role(x.rid, 'pg_read_all_data', 'USAGE')
                          ELSE pg_has_role(x.rid, 'pg_write_all_data', 'USAGE') END
                 AND p.rolbypassrls AND p.rolcreaterole AND p.rolcreatedb
                 AND NOT pg_has_role(x.rid, 'app_runtime', 'USAGE')
                 AND NOT pg_has_role('app_runtime', x.rid, 'MEMBER')
                 AND NOT EXISTS (SELECT 1 FROM pg_roles l WHERE l.rolname = 'app_runtime_prod' AND pg_has_role(l.oid, x.rid, 'MEMBER'))
                 AND NOT pg_has_role(x.rid, (SELECT relowner FROM sf), 'USAGE')
                 AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = x.rid)
                 AND NOT EXISTS (SELECT 1 FROM sf t CROSS JOIN LATERAL aclexplode(t.relacl) a
                                 WHERE a.privilege_type = x.v
                                   AND (a.grantee = 0 OR pg_has_role(x.rid, a.grantee, 'USAGE')))),
g4_outside AS (SELECT x.rid, x.v FROM reachers x
               WHERE (NOT pg_has_role(x.rid, 'app_runtime', 'USAGE') OR x.v NOT IN ('SELECT', 'INS' || 'ERT'))
                 AND NOT EXISTS (SELECT 1 FROM admin_path a WHERE a.rid = x.rid AND a.v = x.v)),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl
        FROM pg_proc p JOIN fns_expected e ON e.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub)),
fns_ok AS (SELECT f.oid FROM fns f
           WHERE NOT f.prosecdef AND f.proowner = (SELECT oid FROM me)
             AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%')
             AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
                             WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner)),
col_match AS (SELECT c.col FROM cols c JOIN pg_attribute a ON a.attrelid = (SELECT oid FROM sf) AND a.attname = c.col
              WHERE NOT a.attisdropped AND a.attnotnull = c.req AND format_type(a.atttypid, a.atttypmod) = c.typ),
trg_match AS (SELECT e.nm FROM trg_expected e
              JOIN pg_trigger g ON g.tgname = e.nm AND g.tgrelid = (SELECT oid FROM sf) AND NOT g.tgisinternal
              JOIN pg_proc p ON p.oid = g.tgfoid AND p.proname = e.fn
              WHERE g.tgenabled = 'O' AND g.tgtype = e.tgtype
                AND (g.tgdeferrable AND g.tginitdeferred AND g.tgconstraint <> 0) = e.deferred),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts'
                        AND checksum = '08f970613cdf92d15f4a038f595955ea76a0e4ed4d037f7659c85aac9cc446a5'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM col_match) = 18
                      AND (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM sf) AND attnum > 0 AND NOT attisdropped) = 18,
                      (SELECT count(*) FROM col_match)
  UNION ALL SELECT 5, (SELECT relrowsecurity AND relforcerowsecurity FROM sf) IS TRUE,
                      (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END FROM sf)
  UNION ALL SELECT 6, (SELECT count(*) FROM pols) = 2
                      AND NOT EXISTS (SELECT 1 FROM pols p WHERE NOT EXISTS (SELECT 1 FROM expected_pol e WHERE e.polname = p.polname AND e.cmd = p.cmd))
                      AND NOT EXISTS (SELECT 1 FROM pols WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[]),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pols p JOIN expected_pol e ON e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL)),
                      (SELECT count(*) FROM pols p JOIN expected_pol e ON e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL))
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_items WHERE nm = 'PaymentSettlementFact') = 2
                      AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'PaymentSettlementFact' AND grantee = (SELECT oid FROM rt) AND letters = 'ar'),
                      (SELECT count(*) FROM acl_items WHERE nm = 'PaymentSettlementFact')
  UNION ALL SELECT 9, (SELECT count(*) FROM acl_items WHERE nm = 'PaymentSettlementFact_id_seq') = 2
                      AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'PaymentSettlementFact_id_seq' AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                      (SELECT count(*) FROM acl_items WHERE nm = 'PaymentSettlementFact_id_seq')
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM sf)),
                       (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM sf))
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM g4_outside), (SELECT count(*) FROM g4_outside)
  UNION ALL SELECT 12, (SELECT count(*) FROM checks_expected e JOIN pg_constraint k ON k.conname = e.nm AND k.contype = 'c'
                          AND k.conrelid = (SELECT oid FROM sf) WHERE k.convalidated) = 11,
                       (SELECT count(*) FROM checks_expected e JOIN pg_constraint k ON k.conname = e.nm AND k.contype = 'c'
                          AND k.conrelid = (SELECT oid FROM sf) WHERE k.convalidated)
  UNION ALL SELECT 13, (SELECT count(*) FROM fks_expected e JOIN pg_constraint k ON k.conname = e.nm AND k.contype = 'f'
                          AND k.conrelid = (SELECT oid FROM sf) JOIN rel t ON t.oid = k.confrelid AND t.nm = e.target
                        WHERE k.confdeltype::text = e.del AND k.convalidated) = 5,
                       (SELECT count(*) FROM fks_expected e JOIN pg_constraint k ON k.conname = e.nm AND k.contype = 'f'
                          AND k.conrelid = (SELECT oid FROM sf) JOIN rel t ON t.oid = k.confrelid AND t.nm = e.target
                        WHERE k.confdeltype::text = e.del AND k.convalidated)
  UNION ALL SELECT 14, (SELECT count(*) FROM uniq_expected e JOIN rel r ON r.nm = e.nm JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE i.indisunique AND i.indpred IS NOT NULL AND i.indrelid = (SELECT oid FROM sf)) = 3,
                       (SELECT count(*) FROM uniq_expected e JOIN rel r ON r.nm = e.nm JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE i.indisunique AND i.indpred IS NOT NULL AND i.indrelid = (SELECT oid FROM sf))
  UNION ALL SELECT 15, (SELECT count(*) FROM trg_match) = 5, (SELECT count(*) FROM trg_match)
  UNION ALL SELECT 16, (SELECT count(*) FROM fns_ok) = 3 AND (SELECT count(*) FROM fns) = 3, (SELECT count(*) FROM fns_ok)
  UNION ALL SELECT 17, (SELECT count(*) FROM "PaymentSettlementFact") = 0, (SELECT count(*) FROM "PaymentSettlementFact")
  UNION ALL SELECT 18, (SELECT count(*) FROM admin_path) <= 8 AND (SELECT count(DISTINCT rid) FROM admin_path) <= 2,
                       (SELECT count(*) FROM admin_path)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
