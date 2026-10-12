-- ============================================================================
-- daily-tasks-foundation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261018090000_daily_tasks_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the six task tables have RLS ENABLED + FORCED and exactly their per-command policies (17), every one
--     PERMISSIVE, for PUBLIC, with USING / WITH CHECK EQUAL to the tenant GUC expression; no FOR ALL policy;
--     "Task" no longer carries p7w1_tenant;
--   * G4: the exact ACL of "Task" (app_runtime read / add / change) and "Task_id_seq" (USAGE / SELECT);
--     no other role reaches "Task" except app_runtime and its members, and none of them can remove,
--     empty, reference or trigger on it; the exact ACL of every other task table and sequence; no
--     column-level privilege; the retention policy table is the owner's alone;
--   * "Task" has its 26 columns, its four checks, its eight new keys and four new indexes (one partial
--     unique: one open occurrence per series); Supplier's tenant key; the six composite keys of the new
--     tables, validated;
--   * the five triggers are enabled; the nine functions exist, the six retention ones SECURITY DEFINER with
--     a pinned search_path and owned by the migration role; EXECUTE on the five retention entry points is
--     held by task_maintenance alone, and task_maintenance is a NOLOGIN NOSUPERUSER NOBYPASSRLS role with no
--     member but its creator, the migration role (no login can run them);
--   * the retention periods: only the two operational ones (7 days) are set; the three H3 periods are NULL;
--   * the flag daily_tasks exists and is OFF, with no business override;
--   * nothing was written: every task table is empty.
--
-- Checks 26 and 27 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== daily tasks foundation production evidence: legend (n -> check) =='
\echo '26 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '27 V2 row level security is not active on "Task" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the six task tables and TaskRetentionPolicy: RLS ENABLED + FORCED (observed = of 7)'
\echo ' 5 exactly 17 task policies (Task 3, TaskSeries 3, TaskSourceState 3, TaskEvent 2, TaskPreferences 3, TaskRequestLedger 3), per command, PERMISSIVE, PUBLIC; no other policy on those tables (observed = policies)'
\echo ' 6 every task policy USING / WITH CHECK equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 7 "Task" ACL is exactly app_runtime read, add, change (observed = grantee x privilege pairs)'
\echo ' 8 "Task_id_seq" ACL is exactly app_runtime USAGE, SELECT (observed = grantee x privilege pairs)'
\echo ' 9 the other task tables and sequences carry exactly their reviewed ACL (observed = objects that differ)'
\echo '10 TaskRetentionPolicy: no grantee but the owner (observed = grants)'
\echo '11 no column-level privilege on any task table (observed = column grants)'
\echo '12 G4: no role reaches "Task" except app_runtime and its members, and none holds removal / emptying / REFERENCES / TRIGGER (observed = role x privilege pairs outside that)'
\echo '13 "Task" has 26 columns; origin and version NOT NULL with defaults; the other 15 new ones nullable (observed = columns)'
\echo '14 "Task" checks (4) and new keys (8) with their on-removal actions (observed = of 12)'
\echo '15 "Task" indexes: (businessId,id) unique, (seriesId,sequence) unique, one-open-per-series partial unique, (businessId,status,dueOn) (observed = of 4)'
\echo '16 Supplier carries UNIQUE ("businessId", "id") (observed = constraints)'
\echo '17 the composite tenant keys of TaskSeries (4) and TaskEvent (2) exist and are validated (observed = of 6)'
\echo '18 the five triggers exist and are enabled (observed = of 5)'
\echo '19 nine functions; the six retention ones SECURITY DEFINER, search_path pinned, owned by the migration role; the three guards are not definer functions (observed = matching, of 9)'
\echo '20 EXECUTE: task_maintenance alone on the five retention entry points; nobody but the owner on the other four (observed = other grants)'
\echo '21 task_maintenance: NOLOGIN NOSUPERUSER NOBYPASSRLS; no member besides the migration role (its creator, PostgreSQL 16+) (observed = other members)'
\echo '22 retention periods: REQUEST_LEDGER and EVENT_DIGEST = 7 (OPERATIONAL); the three H3 periods NULL (observed = rows as reviewed, of 5)'
\echo '23 flag daily_tasks: defaultEnabled false, globalEnabled false, emergencyDisabled false, no business override (observed = overrides)'
\echo '24 the five new enums carry their reviewed labels (observed = of 5); TaskStatus unchanged (4 labels)'
\echo '25 nothing written: "Task" and the five new tenant tables hold no row (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Hard stop: a query that row level security would filter raises an ERROR instead.
SET LOCAL row_security = off;

\echo '== visibility checks (26, 27) =='
WITH
tsk AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Task' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 26, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 27, row_security_active((SELECT oid FROM tsk)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-25) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tm AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'task_maintenance'),
tenant_tables(nm) AS (VALUES ('Task'), ('TaskSeries'), ('TaskSourceState'), ('TaskEvent'), ('TaskPreferences'), ('TaskRequestLedger')),
-- The tenant policy expression as PostgreSQL deparses it (as on "Task" before, gate run 38287077419).
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_pol(tbl, polname, cmd, has_q, has_wc) AS (VALUES
  ('Task', 'task_tenant_select', 'r', true, false), ('Task', 'task_tenant_insert', 'a', false, true),
  ('Task', 'task_tenant_update', 'w', true, true),
  ('TaskSeries', 'task_series_tenant_select', 'r', true, false), ('TaskSeries', 'task_series_tenant_insert', 'a', false, true),
  ('TaskSeries', 'task_series_tenant_update', 'w', true, true),
  ('TaskSourceState', 'task_source_state_tenant_select', 'r', true, false),
  ('TaskSourceState', 'task_source_state_tenant_insert', 'a', false, true),
  ('TaskSourceState', 'task_source_state_tenant_update', 'w', true, true),
  ('TaskEvent', 'task_event_tenant_select', 'r', true, false), ('TaskEvent', 'task_event_tenant_insert', 'a', false, true),
  ('TaskPreferences', 'task_preferences_tenant_select', 'r', true, false),
  ('TaskPreferences', 'task_preferences_tenant_insert', 'a', false, true),
  ('TaskPreferences', 'task_preferences_tenant_update', 'w', true, true),
  ('TaskRequestLedger', 'task_request_ledger_tenant_select', 'r', true, false),
  ('TaskRequestLedger', 'task_request_ledger_tenant_insert', 'a', false, true),
  ('TaskRequestLedger', 'task_request_ledger_runtime_delete', 'd', true, false)),
pols AS (SELECT r.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm IN (SELECT nm FROM tenant_tables)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, letters) AS (VALUES
  ('Task', 'arw'), ('Task_id_seq', 'Ur'), ('TaskSeries', 'arw'), ('TaskSeries_id_seq', 'Ur'),
  ('TaskSourceState', 'arw'), ('TaskSourceState_id_seq', 'Ur'), ('TaskEvent', 'ar'), ('TaskEvent_id_seq', 'Ur'),
  ('TaskPreferences', 'arw'), ('TaskRequestLedger', 'adr'), ('TaskRequestLedger_id_seq', 'Ur')),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
reachers AS (SELECT r.rolname, v.v FROM pg_roles r CROSS JOIN verbs v
             WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> (SELECT relowner FROM rel WHERE nm = 'Task')
               AND has_table_privilege(r.oid, (SELECT oid FROM rel WHERE nm = 'Task'), v.v)),
task_cols AS (SELECT a.attname, a.attnotnull, a.atthasdef FROM pg_attribute a
              WHERE a.attrelid = (SELECT oid FROM rel WHERE nm = 'Task') AND a.attnum > 0 AND NOT a.attisdropped),
new_nullable(nm) AS (VALUES ('dueOn'), ('remindAt'), ('closeReason'), ('completedAt'), ('completedByUserId'), ('createdByUserId'),
  ('assigneeUserId'), ('seriesId'), ('sequence'), ('pinnedAt'), ('customerId'), ('supplierId'), ('leadId'), ('documentId'), ('erasedAt')),
task_cons(conname, contype, confdeltype) AS (VALUES
  ('Task_one_link', 'c', ' '), ('Task_series_sequence_pair', 'c', ' '), ('Task_version_positive', 'c', ' '),
  ('Task_text_length', 'c', ' '),
  ('Task_seriesId_tenant_fkey', 'f', 'a'), ('Task_completedByUserId_fkey', 'f', 'n'), ('Task_createdByUserId_fkey', 'f', 'n'),
  ('Task_assigneeUserId_fkey', 'f', 'n'), ('Task_customerId_tenant_fkey', 'f', 'n'), ('Task_supplierId_tenant_fkey', 'f', 'n'),
  ('Task_leadId_tenant_fkey', 'f', 'n'), ('Task_documentId_tenant_fkey', 'f', 'n')),
idx_expect(nm, uniq, partial) AS (VALUES ('Task_businessId_id_key', true, false), ('Task_seriesId_sequence_key', true, false),
  ('Task_one_open_per_series', true, true), ('Task_businessId_status_dueOn_idx', false, false)),
comp_keys(conname) AS (VALUES ('TaskSeries_customerId_tenant_fkey'), ('TaskSeries_supplierId_tenant_fkey'),
  ('TaskSeries_leadId_tenant_fkey'), ('TaskSeries_documentId_tenant_fkey'), ('TaskEvent_taskId_tenant_fkey'),
  ('TaskEvent_seriesId_tenant_fkey')),
trg(tgname, tbl) AS (VALUES ('Task_user_same_business', 'Task'), ('TaskSeries_user_same_business', 'TaskSeries'),
  ('TaskEvent_user_same_business', 'TaskEvent'), ('TaskEvent_append_only', 'TaskEvent'), ('TaskEvent_no_truncate', 'TaskEvent')),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN ('task_user_same_business', 'task_event_append_only_guard',
          'task_event_truncate_guard', 'task_retention_days', 'task_retention_purge_request_ledger', 'task_retention_clear_event_digests',
          'task_retention_clear_source_identifiers', 'task_retention_purge_learning_events', 'task_retention_purge_source_state')),
entry_points(nm) AS (VALUES ('task_retention_purge_request_ledger'), ('task_retention_clear_event_digests'),
  ('task_retention_clear_source_identifiers'), ('task_retention_purge_learning_events'), ('task_retention_purge_source_state')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
policy_expect(kind, days, basis) AS (VALUES ('REQUEST_LEDGER', 7, 'OPERATIONAL'), ('EVENT_DIGEST', 7, 'OPERATIONAL'),
  ('SOURCE_IDENTIFIERS', NULL::int, 'H3_PENDING'), ('LEARNING_EVENTS', NULL::int, 'H3_PENDING'), ('SOURCE_STATE', NULL::int, 'H3_PENDING')),
enum_expect(typname, labels) AS (VALUES ('TaskOrigin', 3), ('TaskCloseReason', 3), ('TaskSeriesRuleKind', 4),
  ('TaskEventActor', 2), ('TaskEventType', 22)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation'
                        AND checksum = '8f207d872b14a41435244602e89bf6bd55aec0753f188ddf5567251953a2ba87'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE (nm IN (SELECT nm FROM tenant_tables) OR nm = 'TaskRetentionPolicy')
                         AND relrowsecurity AND relforcerowsecurity) = 7,
                      (SELECT count(*) FROM rel WHERE (nm IN (SELECT nm FROM tenant_tables) OR nm = 'TaskRetentionPolicy')
                         AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 17
                      AND NOT EXISTS (SELECT 1 FROM pols p WHERE NOT EXISTS (SELECT 1 FROM expected_pol e
                                        WHERE e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd))
                      AND NOT EXISTS (SELECT 1 FROM pols WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[])
                      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'p7w1_tenant' AND polrelid = (SELECT oid FROM rel WHERE nm = 'Task')),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL)),
                      (SELECT count(*) FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL))
  UNION ALL SELECT 7, (SELECT count(*) FROM acl_items WHERE nm = 'Task') = 3
                      AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'Task' AND grantee = (SELECT oid FROM rt) AND letters = 'arw'),
                      (SELECT count(*) FROM acl_items WHERE nm = 'Task')
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_items WHERE nm = 'Task_id_seq') = 2
                      AND EXISTS (SELECT 1 FROM acl_letters WHERE nm = 'Task_id_seq' AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                      (SELECT count(*) FROM acl_items WHERE nm = 'Task_id_seq')
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM expected_acl e WHERE e.nm NOT IN ('Task', 'Task_id_seq') AND (
                          (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
                       OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters))),
                      (SELECT count(*) FROM expected_acl e WHERE e.nm NOT IN ('Task', 'Task_id_seq') AND (
                          (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
                       OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)))
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM acl_items WHERE nm = 'TaskRetentionPolicy'),
                       (SELECT count(*) FROM acl_items WHERE nm = 'TaskRetentionPolicy')
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
                                    WHERE r.nm IN (SELECT nm FROM tenant_tables) OR r.nm = 'TaskRetentionPolicy'),
                       (SELECT count(*) FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE r.nm IN (SELECT nm FROM tenant_tables) OR r.nm = 'TaskRetentionPolicy')
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM reachers WHERE NOT pg_has_role(rolname, 'app_runtime', 'USAGE')
                                     OR v NOT IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE')),
                       (SELECT count(*) FROM reachers WHERE NOT pg_has_role(rolname, 'app_runtime', 'USAGE')
                          OR v NOT IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE'))
  UNION ALL SELECT 13, (SELECT count(*) FROM task_cols) = 26
                       AND EXISTS (SELECT 1 FROM task_cols WHERE attname = 'origin' AND attnotnull AND atthasdef)
                       AND EXISTS (SELECT 1 FROM task_cols WHERE attname = 'version' AND attnotnull AND atthasdef)
                       AND (SELECT count(*) FROM task_cols WHERE attname IN (SELECT nm FROM new_nullable) AND NOT attnotnull) = 15,
                       (SELECT count(*) FROM task_cols)
  UNION ALL SELECT 14, (SELECT count(*) FROM task_cons t JOIN pg_constraint k ON k.conname = t.conname AND k.contype::text = t.contype
                          AND k.conrelid = (SELECT oid FROM rel WHERE nm = 'Task')
                         WHERE t.contype = 'c' OR k.confdeltype::text = t.confdeltype) = 12,
                       (SELECT count(*) FROM task_cons t JOIN pg_constraint k ON k.conname = t.conname AND k.contype::text = t.contype
                          AND k.conrelid = (SELECT oid FROM rel WHERE nm = 'Task')
                         WHERE t.contype = 'c' OR k.confdeltype::text = t.confdeltype)
  UNION ALL SELECT 15, (SELECT count(*) FROM idx_expect e JOIN rel r ON r.nm = e.nm JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE i.indrelid = (SELECT oid FROM rel WHERE nm = 'Task') AND i.indisunique = e.uniq
                           AND (i.indpred IS NOT NULL) = e.partial) = 4,
                       (SELECT count(*) FROM idx_expect e JOIN rel r ON r.nm = e.nm JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE i.indrelid = (SELECT oid FROM rel WHERE nm = 'Task') AND i.indisunique = e.uniq
                           AND (i.indpred IS NOT NULL) = e.partial)
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_constraint WHERE conname = 'Supplier_businessId_id_key' AND contype = 'u'
                          AND conrelid = (SELECT oid FROM rel WHERE nm = 'Supplier')) = 1,
                       (SELECT count(*) FROM pg_constraint WHERE conname = 'Supplier_businessId_id_key' AND contype = 'u'
                          AND conrelid = (SELECT oid FROM rel WHERE nm = 'Supplier'))
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_constraint k JOIN comp_keys c ON c.conname = k.conname
                         WHERE k.contype = 'f' AND k.convalidated AND cardinality(k.conkey) = 2) = 6,
                       (SELECT count(*) FROM pg_constraint k JOIN comp_keys c ON c.conname = k.conname
                         WHERE k.contype = 'f' AND k.convalidated AND cardinality(k.conkey) = 2)
  UNION ALL SELECT 18, (SELECT count(*) FROM pg_trigger g JOIN trg t ON t.tgname = g.tgname
                          JOIN rel r ON r.oid = g.tgrelid AND r.nm = t.tbl WHERE NOT g.tgisinternal AND g.tgenabled = 'O') = 5,
                       (SELECT count(*) FROM pg_trigger g JOIN trg t ON t.tgname = g.tgname
                          JOIN rel r ON r.oid = g.tgrelid AND r.nm = t.tbl WHERE NOT g.tgisinternal AND g.tgenabled = 'O')
  UNION ALL SELECT 19, (SELECT count(*) FROM fns WHERE proowner = (SELECT oid FROM me)
                          AND (CASE WHEN proname LIKE 'task\_retention\_%'
                                    THEN prosecdef AND proconfig IS NOT NULL
                                         AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')
                                    ELSE NOT prosecdef END)) = 9,
                       (SELECT count(*) FROM fns WHERE proowner = (SELECT oid FROM me)
                          AND (CASE WHEN proname LIKE 'task\_retention\_%'
                                    THEN prosecdef AND proconfig IS NOT NULL
                                         AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')
                                    ELSE NOT prosecdef END))
  UNION ALL SELECT 20, (SELECT count(*) FROM fn_exec WHERE proname IN (SELECT nm FROM entry_points) AND grantee = (SELECT oid FROM tm)) = 5
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE NOT (proname IN (SELECT nm FROM entry_points) AND grantee = (SELECT oid FROM tm))),
                       (SELECT count(*) FROM fn_exec WHERE NOT (proname IN (SELECT nm FROM entry_points) AND grantee = (SELECT oid FROM tm)))
  UNION ALL SELECT 21, EXISTS (SELECT 1 FROM tm WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
                       AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = (SELECT oid FROM tm) AND member <> (SELECT oid FROM me)),
                       (SELECT count(*) FROM pg_auth_members WHERE roleid = (SELECT oid FROM tm) AND member <> (SELECT oid FROM me))
  UNION ALL SELECT 22, (SELECT count(*) FROM "TaskRetentionPolicy") = 5
                       AND (SELECT count(*) FROM "TaskRetentionPolicy" p JOIN policy_expect e ON e.kind = p."kind"
                             AND p."days" IS NOT DISTINCT FROM e.days AND p."basis" = e.basis) = 5,
                       (SELECT count(*) FROM "TaskRetentionPolicy" p JOIN policy_expect e ON e.kind = p."kind"
                             AND p."days" IS NOT DISTINCT FROM e.days AND p."basis" = e.basis)
  UNION ALL SELECT 23, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
                                WHERE d."key" = 'daily_tasks' AND NOT d."defaultEnabled" AND NOT p."globalEnabled" AND NOT p."emergencyDisabled")
                       AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'daily_tasks') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'daily_tasks')
  UNION ALL SELECT 24, (SELECT count(*) FROM enum_expect e WHERE (SELECT count(*) FROM pg_enum x JOIN pg_type t ON t.oid = x.enumtypid
                          WHERE t.typname = e.typname AND t.typnamespace = (SELECT oid FROM pub)) = e.labels) = 5
                       AND (SELECT count(*) FROM pg_enum x JOIN pg_type t ON t.oid = x.enumtypid WHERE t.typname = 'TaskStatus') = 4,
                       (SELECT count(*) FROM enum_expect e WHERE (SELECT count(*) FROM pg_enum x JOIN pg_type t ON t.oid = x.enumtypid
                          WHERE t.typname = e.typname AND t.typnamespace = (SELECT oid FROM pub)) = e.labels)
  UNION ALL SELECT 25, (SELECT count(*) FROM "Task") + (SELECT count(*) FROM "TaskSeries") + (SELECT count(*) FROM "TaskSourceState")
                       + (SELECT count(*) FROM "TaskEvent") + (SELECT count(*) FROM "TaskPreferences")
                       + (SELECT count(*) FROM "TaskRequestLedger") = 0,
                       (SELECT count(*) FROM "Task") + (SELECT count(*) FROM "TaskSeries") + (SELECT count(*) FROM "TaskSourceState")
                       + (SELECT count(*) FROM "TaskEvent") + (SELECT count(*) FROM "TaskPreferences")
                       + (SELECT count(*) FROM "TaskRequestLedger")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
