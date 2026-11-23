-- ============================================================================
-- service-desk-case-records-preflight.sql — read-only PREFLIGHT before migration
--   20261222090000_service_desk_case_records   (NOT applied)
-- Proves Production is the shape the migration expects. Catalog, ledger and counts only. Guard-clean.
-- Rows 12-15 are fingerprints / counts to set side by side with the post-apply evidence
-- (service-desk-case-records-production-evidence.sql rows 9-12): the migration must leave them as they are.
-- Rows 16-18: the release order (nothing after it applied; billing 4a 20261223* stays pending). Row 19: a fingerprint of
-- the journal history before a fixed instant (= evidence 16: no earlier record is touched).
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== service desk case records preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261222090000_service_desk_case_records is NOT recorded'
\echo ' 3 prerequisite 20261122090000_service_desk_audit_journal (P4) is recorded and finished'
\echo ' 4 prerequisite 20261214090000_service_desk_case_fields (A7) is recorded and finished'
\echo ' 5 release order: 20261216090000_activity_packs (sorts before it) is recorded and finished'
\echo ' 6 the P4 CHECK ServiceCaseEvent_record_in_place exists, validated'
\echo ' 7 the closed-payload CHECK ServiceCaseEvent_payload_closed exists, validated'
\echo ' 8 the new CHECK ServiceCaseEvent_case_records_in_place does not exist yet'
\echo ' 9 none of the ten new enum values exists yet'
\echo '10 ServiceCaseLoaner, ServiceCase.itemLocationNote and Task.serviceCaseId exist (A7 shape)'
\echo '11 role app_runtime exists'
\echo '12 fingerprint: privileges on every public relation (informational, compare with evidence 9)'
\echo '13 fingerprint: every row-level policy (informational, compare with evidence 10)'
\echo '14 ServiceCaseEvent rows (informational, compare with evidence 11)'
\echo '15 ServiceEventType + ServiceCaseAction labels (informational; evidence 12 = this + 10)'
\echo '16 release order: applied migrations that sort after 20261222090000 (expected 0)'
\echo '17 release order: 20261223090000 / 20261223100000 (billing 4a, another session) recorded (expected 0, they stay pending)'
\echo '18 release order: 20261221190000_service_desk_open_all is recorded and finished'
\echo '19 fingerprint: every journal row that occurred before 2026-11-23 18:00 UTC (informational, = evidence 16)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261222090000_service_desk_case_records'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261122090000_service_desk_audit_journal' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261214090000_service_desk_case_fields' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261216090000_activity_packs' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place' AND convalidated), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_payload_closed' AND convalidated), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE (t.typname = 'ServiceEventType' AND e.enumlabel IN ('case.work_details_recorded', 'loan.lent', 'loan.returned', 'task.linked', 'task.unlinked'))
                           OR (t.typname = 'ServiceCaseAction' AND e.enumlabel IN ('RECORD_WORK_DETAILS', 'LEND_ITEM', 'RETURN_ITEM', 'LINK_TASK', 'UNLINK_TASK'))), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'ServiceCaseLoaner')
                     + (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
                          AND ((table_name = 'ServiceCase' AND column_name = 'itemLocationNote') OR (table_name = 'Task' AND column_name = 'serviceCaseId'))), 3
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 12, (SELECT ('x' || substr(md5(string_agg(k.relname || ':' || coalesce(k.relacl::text, '-'), ',' ORDER BY k.relname)), 1, 8))::bit(32)::int
                          FROM pg_class k WHERE k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p', 'v', 'm', 'S')), NULL
  UNION ALL SELECT 13, (SELECT ('x' || substr(md5(string_agg(y.tablename || ':' || y.policyname || ':' || y.cmd || ':' || coalesce(y.qual, '-') || ':' || coalesce(y.with_check, '-'),
                                                         ',' ORDER BY y.tablename, y.policyname)), 1, 8))::bit(32)::int
                          FROM pg_policies y WHERE y.schemaname = 'public'), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceCaseEvent"), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname IN ('ServiceEventType', 'ServiceCaseAction')), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261222090000_service_desk_case_records'), 0
  UNION ALL SELECT 17, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name LIKE '20261223090000\_%' OR migration_name LIKE '20261223100000\_%'), 0
  UNION ALL SELECT 18, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221190000_service_desk_open_all' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 19, (SELECT ('x' || substr(md5(coalesce(string_agg(v."id"::text || ':' || v."businessId"::text || ':' || v."caseId"::text || ':' || v.seq::text || ':' || v."eventType"::text || ':'
                                                         || v.action::text || ':' || v."toStatus"::text || ':' || v.actor::text || ':' || coalesce(v."actorUserId"::text, '-') || ':'
                                                         || v."occurredAt"::text || ':' || coalesce(v.payload::text, '-'), ',' ORDER BY v."id"), '-')), 1, 8))::bit(32)::int
                          FROM "ServiceCaseEvent" v WHERE v."occurredAt" < TIMESTAMP '2026-11-23 18:00:00'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
