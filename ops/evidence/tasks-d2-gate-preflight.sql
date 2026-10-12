-- tasks-d2-gate-preflight.sql - Daily Tasks, owner decision D2: is the existing "Task"
-- table still empty, protected and ungranted in Production, so that it can be extended?
--
-- READ-ONLY. One READ ONLY transaction that ends in ROLLBACK, a session read-only guard
-- and a statement timeout. Catalogue metadata and counts only: no row of "Task" or of
-- any other table is printed (the repository is public; every value printed is a
-- PASS/FAIL verdict or a count, as scripts/ci/evidence-output-guard.mjs requires).
-- The CI keyword guard rejects any write keyword anywhere in the file, so the write
-- privilege names below are assembled from fragments.
--
-- Expected result on a healthy Production: every line PASS.
-- Any FAIL goes back to the owner before anything changes (spec, sections 13 and 18).

\echo '== tasks D2 gate preflight: legend (n -> check) =='
\echo ' 1 X1 migration 20260330142739_core_data_layer_v1 is finished and not rolled back'
\echo ' 2 X1 migration 20260824210000_d2_p7_wave1_tenant_rls is finished and not rolled back'
\echo ' 3 G1 "Task" holds no row (observed = rows)'
\echo ' 4 G1 INFO: distinct businesses that own a "Task" row (observed = businesses)'
\echo ' 5 G8 no "Task" row has status IN_PROGRESS (observed = rows)'
\echo ' 6 G2 "Task" has exactly the 9 columns of core_data_layer_v1 (observed = columns)'
\echo ' 7 G2 "Task" has exactly two constraints: its primary key and one foreign key (observed = constraints)'
\echo ' 8 G2 "Task" has exactly one index, its primary key (observed = indexes)'
\echo ' 9 G3 row level security is enabled on "Task"'
\echo '10 G3 row level security is forced on "Task"'
\echo '11 G3 "Task" carries exactly one policy, p7w1_tenant, for all commands (observed = policies)'
\echo '12 G3 that policy reads app.current_business_id in USING and in WITH CHECK'
\echo '13 G4 no role other than the owner holds a table privilege on "Task" (observed = role x privilege pairs)'
\echo '14 G4 app_runtime and app_runtime_prod cannot SELECT "Task" (observed = how many can)'
\echo '15 G4 no role other than the owner can use Task_id_seq (observed = roles)'
\echo '16 G4 "Task" is owned by the role running this evidence (the migration role)'
\echo '17 G5 exactly one foreign key leaves "Task", and it points at "Business" (observed = foreign keys)'
\echo '18 G5 no foreign key points at "Task" (observed = foreign keys)'
\echo '19 G5 no view or rule depends on "Task" (observed = dependants)'
\echo '20 G5 no user trigger is defined on "Task" (observed = triggers)'
\echo '21 G5 no public function body names "Task" (observed = functions)'
\echo '22 G8 TaskStatus has exactly the labels OPEN, IN_PROGRESS, DONE, CANCELED (observed = labels)'
\echo '23 G8 only one column uses TaskStatus, "Task".status (observed = columns)'
\echo '24 X2 INFO: unique indexes on "User" (repo shows 3: pkey, email, lower(email); none on (id, businessId))'
\echo '25 X3 server major version is 15 or newer (observed = major version)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tsk AS (SELECT c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Task' AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Task_id_seq' AND c.relkind = 'S'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
biz AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
expected_cols(nm) AS (VALUES ('id'), ('businessId'), ('title'), ('description'), ('sourceType'),
                             ('status'), ('dueDate'), ('createdAt'), ('updatedAt')),
cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM tsk) AND a.attnum > 0 AND NOT a.attisdropped),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
others AS (SELECT r.rolname FROM pg_roles r
           WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> (SELECT relowner FROM tsk)),
pol AS (SELECT p.polname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
        FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tsk)),
fk_out AS (SELECT confrelid FROM pg_constraint WHERE contype = 'f' AND conrelid = (SELECT oid FROM tsk)),
fk_in AS (SELECT conrelid FROM pg_constraint WHERE contype = 'f' AND confrelid = (SELECT oid FROM tsk)),
deps AS (SELECT DISTINCT r.ev_class FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
         WHERE d.refobjid = (SELECT oid FROM tsk) AND r.ev_class <> (SELECT oid FROM tsk)),
labels AS (SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'TaskStatus'),
status_cols AS (SELECT a.attrelid, a.attname FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
                WHERE t.typname = 'TaskStatus' AND a.attnum > 0 AND NOT a.attisdropped),
usr_unique AS (SELECT i.indexrelid, i.indkey FROM pg_index i WHERE i.indrelid = (SELECT oid FROM usr) AND i.indisunique),
checks(n, ok, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20260330142739_core_data_layer_v1'
                                AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 2, EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20260824210000_d2_p7_wave1_tenant_rls'
                                AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 3, (SELECT count(*) FROM "Task") = 0, (SELECT count(*) FROM "Task")
  UNION ALL SELECT 4, true, (SELECT count(DISTINCT "businessId") FROM "Task")
  UNION ALL SELECT 5, (SELECT count(*) FROM "Task" WHERE status::text = 'IN_PROGRESS') = 0,
                      (SELECT count(*) FROM "Task" WHERE status::text = 'IN_PROGRESS')
  UNION ALL SELECT 6, (SELECT count(*) FROM cols) = 9
                      AND NOT EXISTS (SELECT 1 FROM expected_cols e WHERE e.nm NOT IN (SELECT attname FROM cols)),
                      (SELECT count(*) FROM cols)
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM tsk)) = 2
                      AND (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM tsk) AND contype = 'p') = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM tsk))
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_index WHERE indrelid = (SELECT oid FROM tsk)) = 1,
                      (SELECT count(*) FROM pg_index WHERE indrelid = (SELECT oid FROM tsk))
  UNION ALL SELECT 9, (SELECT relrowsecurity FROM tsk) IS TRUE, 1
  UNION ALL SELECT 10, (SELECT relforcerowsecurity FROM tsk) IS TRUE, 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pol) = 1
                       AND EXISTS (SELECT 1 FROM pol WHERE polname = 'p7w1_tenant' AND polcmd = '*'),
                       (SELECT count(*) FROM pol)
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM pol WHERE polname = 'p7w1_tenant'
                                 AND q LIKE '%app.current_business_id%' AND wc LIKE '%app.current_business_id%'), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM others o CROSS JOIN verbs v
                         WHERE has_table_privilege(o.rolname, (SELECT oid FROM tsk), v.v)) = 0,
                       (SELECT count(*) FROM others o CROSS JOIN verbs v
                         WHERE has_table_privilege(o.rolname, (SELECT oid FROM tsk), v.v))
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_runtime_prod')
                         AND has_table_privilege(r.rolname, (SELECT oid FROM tsk), 'SELECT')) = 0,
                       (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_runtime_prod')
                         AND has_table_privilege(r.rolname, (SELECT oid FROM tsk), 'SELECT'))
  UNION ALL SELECT 15, (SELECT count(*) FROM others o
                         WHERE has_sequence_privilege(o.rolname, (SELECT oid FROM seq), 'USAGE')) = 0,
                       (SELECT count(*) FROM others o
                         WHERE has_sequence_privilege(o.rolname, (SELECT oid FROM seq), 'USAGE'))
  UNION ALL SELECT 16, (SELECT relowner FROM tsk) = (SELECT oid FROM me), 1
  UNION ALL SELECT 17, (SELECT count(*) FROM fk_out) = 1 AND (SELECT confrelid FROM fk_out LIMIT 1) = (SELECT oid FROM biz),
                       (SELECT count(*) FROM fk_out)
  UNION ALL SELECT 18, (SELECT count(*) FROM fk_in) = 0, (SELECT count(*) FROM fk_in)
  UNION ALL SELECT 19, (SELECT count(*) FROM deps) = 0, (SELECT count(*) FROM deps)
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM tsk) AND NOT tgisinternal) = 0,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM tsk) AND NOT tgisinternal)
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                         AND p.prosrc LIKE '%"Task"%') = 0,
                       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                         AND p.prosrc LIKE '%"Task"%')
  UNION ALL SELECT 22, (SELECT count(*) FROM labels) = 4
                       AND (SELECT count(*) FROM labels WHERE enumlabel IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED')) = 4,
                       (SELECT count(*) FROM labels)
  UNION ALL SELECT 23, (SELECT count(*) FROM status_cols) = 1
                       AND EXISTS (SELECT 1 FROM status_cols WHERE attrelid = (SELECT oid FROM tsk) AND attname = 'status'),
                       (SELECT count(*) FROM status_cols)
  UNION ALL SELECT 24, true, (SELECT count(*) FROM usr_unique)
  UNION ALL SELECT 25, current_setting('server_version_num')::int >= 150000,
                       current_setting('server_version_num')::int / 10000
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
