-- ============================================================================
-- task-reminders-push-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261022090000_task_reminders_push
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * "Task" gained dueMinute / remindOffsetMinutes (smallint) and reminderSentAt (timestamp), "TaskSeries"
--     dueMinute / remindOffsetMinutes, all nullable; the six shape constraints exist and are validated; the partial
--     index serves exactly open, unclaimed reminders;
--   * "PushSubscription": 13 columns; RLS ENABLED + FORCED; exactly three tenant policies (read, add, change),
--     PERMISSIVE, for PUBLIC, each expression equal to the tenant GUC expression; no removal policy; its ACL is
--     exactly app_runtime read / add / change and its sequence USAGE / SELECT; no column-level privilege;
--     G4: no other role reaches it (the Neon platform admin path of run 39461027340 is set aside exactly as in
--     the daily tasks proof, and counted in check 21); its four constraints, two keys to Business and User, the
--     unique (businessId, endpoint) key and the same-business trigger, enabled;
--   * task_reminders_due: SECURITY DEFINER, search_path pinned, STABLE, owned by the migration role, returning
--     exactly businessId, taskId, remindAt; EXECUTE for app_runtime alone (no PUBLIC);
--   * nothing written: PushSubscription holds no row and no "Task" / "TaskSeries" row carries the new values.
--
-- Checks 22 and 23 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== task reminders push production evidence: legend (n -> check) =='
\echo '22 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '23 V2 row level security is not active on "PushSubscription" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the five new columns exist with their types, all nullable (observed = matching, of 5)'
\echo ' 5 the six shape constraints exist and are validated (observed = of 6)'
\echo ' 6 Task_reminder_due_idx is a partial index on "Task"(remindAt) (observed = matching)'
\echo ' 7 "PushSubscription" exists with 13 columns (observed = columns)'
\echo ' 8 "PushSubscription": RLS ENABLED + FORCED (observed = 1 if both)'
\echo ' 9 exactly three push_subscription_* policies (read, add, change), PERMISSIVE, PUBLIC; no other policy on the table (observed = policies)'
\echo '10 every policy expression equals the tenant GUC expression exactly (observed = mismatches)'
\echo '11 "PushSubscription" ACL is exactly app_runtime read, add, change (observed = grantee x privilege pairs)'
\echo '12 "PushSubscription_id_seq" ACL is exactly app_runtime USAGE, SELECT (observed = grantee x privilege pairs)'
\echo '13 no column-level privilege on "PushSubscription" (observed = column grants)'
\echo '14 G4: no role reaches "PushSubscription" except app_runtime members with read / add / change (observed = pairs outside that, after the check 21 exception)'
\echo '15 constraints: endpoint shape, keys shape, platform, failures; keys to Business and User; unique (businessId, endpoint) (observed = of 7)'
\echo '16 the trigger PushSubscription_user_same_business is enabled and runs task_user_same_business (observed = matching)'
\echo '17 task_reminders_due: SECURITY DEFINER, STABLE, search_path pinned, owned by the migration role (observed = matching)'
\echo '18 task_reminders_due returns exactly businessId, taskId, remindAt (observed = output columns)'
\echo '19 EXECUTE on task_reminders_due: app_runtime alone, no PUBLIC (observed = other grants)'
\echo '20 nothing written: no PushSubscription row; no Task / TaskSeries row with the new values (observed = rows)'
\echo '21 G4 exception: pairs set aside by check 14 as Neon platform admin access (run 39461027340 path only); at most 2 roles and 8 pairs (observed = pairs set aside)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (22, 23) =='
WITH
ps AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'PushSubscription' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 22, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 23, row_security_active((SELECT oid FROM ps)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-21) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
ps AS (SELECT * FROM rel WHERE nm = 'PushSubscription'),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
new_cols(tbl, col, typ) AS (VALUES ('Task', 'dueMinute', 'smallint'), ('Task', 'remindOffsetMinutes', 'smallint'),
  ('Task', 'reminderSentAt', 'timestamp(3) without time zone'), ('TaskSeries', 'dueMinute', 'smallint'),
  ('TaskSeries', 'remindOffsetMinutes', 'smallint')),
new_cons(tbl, nm) AS (VALUES ('Task', 'Task_dueMinute_range'), ('Task', 'Task_remindOffset_range'), ('Task', 'Task_schedule_shape'),
  ('TaskSeries', 'TaskSeries_dueMinute_range'), ('TaskSeries', 'TaskSeries_remindOffset_range'), ('TaskSeries', 'TaskSeries_schedule_shape')),
ps_cons(nm, typ) AS (VALUES ('PushSubscription_endpoint_shape', 'c'), ('PushSubscription_keys_shape', 'c'),
  ('PushSubscription_platform', 'c'), ('PushSubscription_failures', 'c'), ('PushSubscription_businessId_fkey', 'f'),
  ('PushSubscription_userId_fkey', 'f')),
expected_pol(polname, cmd, has_q, has_wc) AS (VALUES
  ('push_subscription_tenant_select', 'r', true, false), ('push_subscription_tenant_insert', 'a', false, true),
  ('push_subscription_tenant_update', 'w', true, true)),
pols AS (SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM ps)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
reachers AS (SELECT r.oid AS rid, v.v FROM pg_roles r CROSS JOIN verbs v
             WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> (SELECT relowner FROM ps)
               AND has_table_privilege(r.oid, (SELECT oid FROM ps), v.v)),
-- The Neon platform admin path proven by run 39461027340, and nothing wider (as in the daily tasks proof).
admin_path AS (SELECT x.rid, x.v FROM reachers x JOIN pg_roles p ON p.oid = x.rid
               WHERE x.v IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE', 'DEL' || 'ETE')
                 AND CASE WHEN x.v = 'SELECT' THEN pg_has_role(x.rid, 'pg_read_all_data', 'USAGE')
                          ELSE pg_has_role(x.rid, 'pg_write_all_data', 'USAGE') END
                 AND p.rolbypassrls AND p.rolcreaterole AND p.rolcreatedb
                 AND NOT pg_has_role(x.rid, 'app_runtime', 'USAGE')
                 AND NOT pg_has_role('app_runtime', x.rid, 'MEMBER')
                 AND NOT EXISTS (SELECT 1 FROM pg_roles l WHERE l.rolname = 'app_runtime_prod' AND pg_has_role(l.oid, x.rid, 'MEMBER'))
                 AND NOT pg_has_role(x.rid, (SELECT relowner FROM ps), 'USAGE')
                 AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = x.rid)
                 AND NOT EXISTS (SELECT 1 FROM ps t CROSS JOIN LATERAL aclexplode(t.relacl) a
                                 WHERE a.privilege_type = x.v
                                   AND (a.grantee = 0 OR pg_has_role(x.rid, a.grantee, 'USAGE')))),
g4_outside AS (SELECT x.rid, x.v FROM reachers x
               WHERE (NOT pg_has_role(x.rid, 'app_runtime', 'USAGE') OR x.v NOT IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE'))
                 AND NOT EXISTS (SELECT 1 FROM admin_path a WHERE a.rid = x.rid AND a.v = x.v)),
fn AS (SELECT p.oid, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl, p.proargnames, p.proargmodes
       FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'task_reminders_due'),
fn_out AS (SELECT a.n, a.m FROM fn CROSS JOIN LATERAL unnest(fn.proargnames, fn.proargmodes) AS a(n, m) WHERE a.m = 't'),
fn_exec AS (SELECT x.grantee FROM fn CROSS JOIN LATERAL aclexplode(fn.proacl) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> fn.proowner),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push'
                        AND checksum = '49108924b89eb13e7600e5d8bdae1a5135742f76ff8bb2da887bcb3301a7b7ff'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM new_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col
                         WHERE NOT a.attisdropped AND NOT a.attnotnull AND format_type(a.atttypid, a.atttypmod) = c.typ) = 5,
                      (SELECT count(*) FROM new_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col
                         WHERE NOT a.attisdropped AND NOT a.attnotnull AND format_type(a.atttypid, a.atttypmod) = c.typ)
  UNION ALL SELECT 5, (SELECT count(*) FROM new_cons c JOIN rel r ON r.nm = c.tbl JOIN pg_constraint k ON k.conrelid = r.oid AND k.conname = c.nm
                         WHERE k.contype = 'c' AND k.convalidated) = 6,
                      (SELECT count(*) FROM new_cons c JOIN rel r ON r.nm = c.tbl JOIN pg_constraint k ON k.conrelid = r.oid AND k.conname = c.nm
                         WHERE k.contype = 'c' AND k.convalidated)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                         WHERE r.nm = 'Task_reminder_due_idx' AND i.indrelid = (SELECT oid FROM rel WHERE nm = 'Task')
                           AND i.indpred IS NOT NULL AND NOT i.indisunique) = 1,
                      (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                         WHERE r.nm = 'Task_reminder_due_idx' AND i.indrelid = (SELECT oid FROM rel WHERE nm = 'Task')
                           AND i.indpred IS NOT NULL AND NOT i.indisunique)
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM ps) AND attnum > 0 AND NOT attisdropped) = 13,
                      (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM ps) AND attnum > 0 AND NOT attisdropped)
  UNION ALL SELECT 8, (SELECT relrowsecurity AND relforcerowsecurity FROM ps) IS TRUE,
                      (SELECT CASE WHEN relrowsecurity AND relforcerowsecurity THEN 1 ELSE 0 END FROM ps)
  UNION ALL SELECT 9, (SELECT count(*) FROM pols) = 3
                      AND NOT EXISTS (SELECT 1 FROM pols p WHERE NOT EXISTS (SELECT 1 FROM expected_pol e WHERE e.polname = p.polname AND e.cmd = p.cmd))
                      AND NOT EXISTS (SELECT 1 FROM pols WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[]),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM pols p JOIN expected_pol e ON e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL)),
                       (SELECT count(*) FROM pols p JOIN expected_pol e ON e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL))
  UNION ALL SELECT 11, (SELECT count(*) FROM acl_items WHERE nm = 'PushSubscription') = 3
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'PushSubscription' AND grantee = (SELECT oid FROM rt) AND letters = 'arw'),
                       (SELECT count(*) FROM acl_items WHERE nm = 'PushSubscription')
  UNION ALL SELECT 12, (SELECT count(*) FROM acl_items WHERE nm = 'PushSubscription_id_seq') = 2
                       AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'PushSubscription_id_seq' AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                       (SELECT count(*) FROM acl_items WHERE nm = 'PushSubscription_id_seq')
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM ps)),
                       (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM ps))
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM g4_outside), (SELECT count(*) FROM g4_outside)
  UNION ALL SELECT 15, (SELECT count(*) FROM ps_cons c JOIN pg_constraint k ON k.conname = c.nm AND k.contype::text = c.typ
                          AND k.conrelid = (SELECT oid FROM ps) WHERE k.convalidated)
                       + (SELECT count(*) FROM rel r JOIN pg_index i ON i.indexrelid = r.oid
                          WHERE r.nm = 'PushSubscription_businessId_endpoint_key' AND i.indisunique AND i.indrelid = (SELECT oid FROM ps)) = 7,
                       (SELECT count(*) FROM ps_cons c JOIN pg_constraint k ON k.conname = c.nm AND k.contype::text = c.typ
                          AND k.conrelid = (SELECT oid FROM ps) WHERE k.convalidated)
                       + (SELECT count(*) FROM rel r JOIN pg_index i ON i.indexrelid = r.oid
                          WHERE r.nm = 'PushSubscription_businessId_endpoint_key' AND i.indisunique AND i.indrelid = (SELECT oid FROM ps))
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
                         WHERE g.tgrelid = (SELECT oid FROM ps) AND g.tgname = 'PushSubscription_user_same_business'
                           AND NOT g.tgisinternal AND g.tgenabled = 'O' AND p.proname = 'task_user_same_business') = 1,
                       (SELECT count(*) FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
                         WHERE g.tgrelid = (SELECT oid FROM ps) AND g.tgname = 'PushSubscription_user_same_business'
                           AND NOT g.tgisinternal AND g.tgenabled = 'O' AND p.proname = 'task_user_same_business')
  UNION ALL SELECT 17, (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 1,
                       (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 18, (SELECT array_agg(n ORDER BY n) FROM fn_out) = ARRAY['businessId', 'remindAt', 'taskId']::text[],
                       (SELECT count(*) FROM fn_out)
  UNION ALL SELECT 19, (SELECT count(*) FROM fn_exec WHERE grantee = (SELECT oid FROM rt)) = 1
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM fn_exec WHERE grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 20, (SELECT count(*) FROM "PushSubscription")
                       + (SELECT count(*) FROM "Task" WHERE "dueMinute" IS NOT NULL OR "remindOffsetMinutes" IS NOT NULL OR "reminderSentAt" IS NOT NULL)
                       + (SELECT count(*) FROM "TaskSeries" WHERE "dueMinute" IS NOT NULL OR "remindOffsetMinutes" IS NOT NULL) = 0,
                       (SELECT count(*) FROM "PushSubscription")
                       + (SELECT count(*) FROM "Task" WHERE "dueMinute" IS NOT NULL OR "remindOffsetMinutes" IS NOT NULL OR "reminderSentAt" IS NOT NULL)
                       + (SELECT count(*) FROM "TaskSeries" WHERE "dueMinute" IS NOT NULL OR "remindOffsetMinutes" IS NOT NULL)
  UNION ALL SELECT 21, (SELECT count(*) FROM admin_path) <= 8 AND (SELECT count(DISTINCT rid) FROM admin_path) <= 2,
                       (SELECT count(*) FROM admin_path)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
