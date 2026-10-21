-- ============================================================================
-- task-reminders-push-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261022090000_task_reminders_push   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded, nothing sorting after it was applied first, and
--     20261018090000_daily_tasks_foundation (which it builds on) is finished;
--   * none of the names it introduces exists: the five new columns, the six constraints, the partial index,
--     the PushSubscription table, its sequence, keys, trigger and policies, the function task_reminders_due;
--   * what it builds on is there: "Task" (status, dueOn, remindAt, erasedAt), the TaskStatus label OPEN,
--     "TaskSeries", Business.deletionRequestedAt / deletedAt, "User", and the guard task_user_same_business
--     (not a definer function, owned by the migration role);
--   * no reminder was ever scheduled: no "Task" row carries remindAt;
--   * the migration role owns Task, TaskSeries, Business and User and carries BYPASSRLS (the new definer
--     function runs as it, over FORCE RLS tables);
--   * app_runtime is a NOLOGIN NOSUPERUSER NOBYPASSRLS group;
--   * INFO: default-privilege entries of the migration role for new tables in public (what the migration takes
--     back from the runtime before it hands out exactly read / add / change);
--   * the server is PostgreSQL 15+.
--
-- Checks 1 and 2 run first: the row count is taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== task reminders push preflight: legend (n -> check) =='
\echo ' 1 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo ' 2 V2 row level security is not active on "Task" for the evidence role (runs first)'
\echo ' 3 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 4 20261022090000_task_reminders_push is not recorded (observed = rows)'
\echo ' 5 no recorded migration sorts after it (observed = such rows)'
\echo ' 6 20261018090000_daily_tasks_foundation is recorded and finished (observed = rows)'
\echo ' 7 "Task" has none of dueMinute, remindOffsetMinutes, reminderSentAt; "TaskSeries" none of dueMinute, remindOffsetMinutes (observed = present)'
\echo ' 8 none of the six new constraint names exists (observed = present)'
\echo ' 9 no relation named PushSubscription, PushSubscription_id_seq, or any of the three new indexes (observed = present)'
\echo '10 no function task_reminders_due; no policy push_subscription_*; no trigger PushSubscription_user_same_business (observed = present)'
\echo '11 "Task" carries status, dueOn, remindAt, erasedAt; Business carries deletionRequestedAt, deletedAt (observed = of 6)'
\echo '12 TaskStatus has the label OPEN (observed = labels named OPEN)'
\echo '13 task_user_same_business exists, is not a definer function, and is owned by the migration role (observed = matching)'
\echo '14 no "Task" row carries remindAt (observed = rows)'
\echo '15 the migration role owns Task, TaskSeries, Business and User (observed = of 4)'
\echo '16 the migration role carries BYPASSRLS (observed = 1 if so)'
\echo '17 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS (observed = matching)'
\echo '18 INFO default-privilege entries of the migration role for new tables in public (observed = entries)'
\echo '19 the server is PostgreSQL 15 or later (observed = major version)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (1, 2) =='
WITH
tsk AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Task' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, row_security_active((SELECT oid FROM tsk)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== preflight checks (3-19) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.relname AS nm, c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid, rolbypassrls FROM pg_roles WHERE rolname = current_user),
cols(tbl, col) AS (VALUES ('Task', 'dueMinute'), ('Task', 'remindOffsetMinutes'), ('Task', 'reminderSentAt'),
                          ('TaskSeries', 'dueMinute'), ('TaskSeries', 'remindOffsetMinutes')),
needed(tbl, col) AS (VALUES ('Task', 'status'), ('Task', 'dueOn'), ('Task', 'remindAt'), ('Task', 'erasedAt'),
                            ('Business', 'deletionRequestedAt'), ('Business', 'deletedAt')),
new_cons(nm) AS (VALUES ('Task_dueMinute_range'), ('Task_remindOffset_range'), ('Task_schedule_shape'),
                        ('TaskSeries_dueMinute_range'), ('TaskSeries_remindOffset_range'), ('TaskSeries_schedule_shape')),
new_rels(nm) AS (VALUES ('PushSubscription'), ('PushSubscription_id_seq'), ('Task_reminder_due_idx'),
                        ('PushSubscription_businessId_endpoint_key'), ('PushSubscription_businessId_userId_live_idx')),
att AS (SELECT r.nm AS tbl, a.attname AS col FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
        WHERE a.attnum > 0 AND NOT a.attisdropped),
checks(n, ok, observed_count) AS (
  SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push')
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261022090000_task_reminders_push') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261022090000_task_reminders_push')
  UNION ALL SELECT 6, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 7, (SELECT count(*) FROM cols c JOIN att a ON a.tbl = c.tbl AND a.col = c.col) = 0,
                      (SELECT count(*) FROM cols c JOIN att a ON a.tbl = c.tbl AND a.col = c.col)
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint k JOIN new_cons x ON x.nm = k.conname) = 0,
                      (SELECT count(*) FROM pg_constraint k JOIN new_cons x ON x.nm = k.conname)
  UNION ALL SELECT 9, (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm) = 0,
                      (SELECT count(*) FROM rel r JOIN new_rels x ON x.nm = r.nm)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE proname = 'task_reminders_due')
                       + (SELECT count(*) FROM pg_policy WHERE polname LIKE 'push\_subscription\_%')
                       + (SELECT count(*) FROM pg_trigger WHERE tgname = 'PushSubscription_user_same_business') = 0,
                       (SELECT count(*) FROM pg_proc WHERE proname = 'task_reminders_due')
                       + (SELECT count(*) FROM pg_policy WHERE polname LIKE 'push\_subscription\_%')
                       + (SELECT count(*) FROM pg_trigger WHERE tgname = 'PushSubscription_user_same_business')
  UNION ALL SELECT 11, (SELECT count(*) FROM needed x JOIN att a ON a.tbl = x.tbl AND a.col = x.col) = 6,
                       (SELECT count(*) FROM needed x JOIN att a ON a.tbl = x.tbl AND a.col = x.col)
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                         WHERE t.typname = 'TaskStatus' AND e.enumlabel = 'OPEN') = 1,
                       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                         WHERE t.typname = 'TaskStatus' AND e.enumlabel = 'OPEN')
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_proc p WHERE p.proname = 'task_user_same_business'
                         AND p.pronamespace = (SELECT oid FROM pub) AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me)) = 1,
                       (SELECT count(*) FROM pg_proc p WHERE p.proname = 'task_user_same_business'
                         AND p.pronamespace = (SELECT oid FROM pub) AND NOT p.prosecdef AND p.proowner = (SELECT oid FROM me))
  UNION ALL SELECT 14, (SELECT count(*) FROM "Task" WHERE "remindAt" IS NOT NULL) = 0,
                       (SELECT count(*) FROM "Task" WHERE "remindAt" IS NOT NULL)
  UNION ALL SELECT 15, (SELECT count(*) FROM rel WHERE nm IN ('Task', 'TaskSeries', 'Business', 'User') AND relowner = (SELECT oid FROM me)) = 4,
                       (SELECT count(*) FROM rel WHERE nm IN ('Task', 'TaskSeries', 'Business', 'User') AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 16, (SELECT rolbypassrls FROM me) IS TRUE, (SELECT CASE WHEN rolbypassrls THEN 1 ELSE 0 END FROM me)
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) = 1,
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 18, true, (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                               WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'r'
                                 AND (d.defaclnamespace = 0 OR d.defaclnamespace = (SELECT oid FROM pub)))
  UNION ALL SELECT 19, current_setting('server_version_num')::int >= 150000, current_setting('server_version_num')::int / 10000
)
SELECT n, CASE WHEN n = 18 THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
