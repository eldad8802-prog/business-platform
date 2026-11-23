-- ============================================================================
-- service-desk-case-records-production-evidence.sql — read-only EVIDENCE after
--   20261222090000_service_desk_case_records was applied. Catalog, ledger and counts only. Guard-clean.
-- Rows 9-12 are set side by side with the preflight (service-desk-case-records-preflight.sql rows 12-15):
-- privileges and policies identical, no existing journal row touched, exactly ten enum labels more.
-- Rows 13-16: no record of the new kinds dated before the migration, billing 4a 20261223* still pending, nothing after
-- it applied, and the journal history before a fixed instant has the preflight's fingerprint (row 19 there).
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== service desk case records evidence: legend (n -> check) =='
\echo ' 1 20261222090000_service_desk_case_records recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the ten new enum values exist (five ServiceEventType, five ServiceCaseAction)'
\echo ' 4 the CHECK ServiceCaseEvent_case_records_in_place exists, validated'
\echo ' 5 the P4 CHECK ServiceCaseEvent_record_in_place is still validated'
\echo ' 6 the closed-payload CHECK ServiceCaseEvent_payload_closed is still validated'
\echo ' 7 no relation, function or policy named for case records was added'
\echo ' 8 journal rows of the five new event types (informational; 0 until the code PR is live)'
\echo ' 9 fingerprint: privileges on every public relation (informational, = preflight 12)'
\echo '10 fingerprint: every row-level policy (informational, = preflight 13)'
\echo '11 ServiceCaseEvent rows (informational, >= preflight 14: rows are only ever added)'
\echo '12 ServiceEventType + ServiceCaseAction labels (informational, = preflight 15 + 10)'
\echo '13 journal rows of the five new event types that occurred before the migration started (expected 0: no backfill, no invented history)'
\echo '14 20261223090000 / 20261223100000 (billing 4a, another session) recorded (expected 0, they stay pending)'
\echo '15 applied migrations that sort after 20261222090000 (expected 0)'
\echo '16 fingerprint: every journal row that occurred before 2026-11-23 18:00 UTC (informational, = preflight 19)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261222090000_service_desk_case_records' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE (t.typname = 'ServiceEventType' AND e.enumlabel IN ('case.work_details_recorded', 'loan.lent', 'loan.returned', 'task.linked', 'task.unlinked'))
                           OR (t.typname = 'ServiceCaseAction' AND e.enumlabel IN ('RECORD_WORK_DETAILS', 'LEND_ITEM', 'RETURN_ITEM', 'LINK_TASK', 'UNLINK_TASK'))), 10
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place' AND convalidated), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place' AND convalidated), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_payload_closed' AND convalidated), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ILIKE '%case_records%')
                    + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ILIKE '%case_records%')
                    + (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname ILIKE '%case_records%'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "eventType"::text IN ('case.work_details_recorded', 'loan.lent', 'loan.returned', 'task.linked', 'task.unlinked')), NULL
  UNION ALL SELECT 9, (SELECT ('x' || substr(md5(string_agg(k.relname || ':' || coalesce(k.relacl::text, '-'), ',' ORDER BY k.relname)), 1, 8))::bit(32)::int
                         FROM pg_class k WHERE k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p', 'v', 'm', 'S')), NULL
  UNION ALL SELECT 10, (SELECT ('x' || substr(md5(string_agg(y.tablename || ':' || y.policyname || ':' || y.cmd || ':' || coalesce(y.qual, '-') || ':' || coalesce(y.with_check, '-'),
                                                         ',' ORDER BY y.tablename, y.policyname)), 1, 8))::bit(32)::int
                          FROM pg_policies y WHERE y.schemaname = 'public'), NULL
  UNION ALL SELECT 11, (SELECT count(*) FROM "ServiceCaseEvent"), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname IN ('ServiceEventType', 'ServiceCaseAction')), NULL
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServiceCaseEvent" v
                         WHERE v."eventType"::text IN ('case.work_details_recorded', 'loan.lent', 'loan.returned', 'task.linked', 'task.unlinked')
                           AND v."occurredAt" < (SELECT min(m.started_at) FROM "_prisma_migrations" m WHERE m.migration_name = '20261222090000_service_desk_case_records')), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name LIKE '20261223090000\_%' OR migration_name LIKE '20261223100000\_%'), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261222090000_service_desk_case_records'), 0
  UNION ALL SELECT 16, (SELECT ('x' || substr(md5(coalesce(string_agg(v."id"::text || ':' || v."businessId"::text || ':' || v."caseId"::text || ':' || v.seq::text || ':' || v."eventType"::text || ':'
                                                         || v.action::text || ':' || v."toStatus"::text || ':' || v.actor::text || ':' || coalesce(v."actorUserId"::text, '-') || ':'
                                                         || v."occurredAt"::text || ':' || coalesce(v.payload::text, '-'), ',' ORDER BY v."id"), '-')), 1, 8))::bit(32)::int
                          FROM "ServiceCaseEvent" v WHERE v."occurredAt" < TIMESTAMP '2026-11-23 18:00:00'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
