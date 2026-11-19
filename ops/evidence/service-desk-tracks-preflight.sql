-- ============================================================================
-- service-desk-tracks-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261127090000_service_desk_tracks   (M1, NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded;
--   * its prerequisites are recorded and finished: the case charge 20261126090000_service_desk_case_charge (#1104),
--     20261125090000 (#1096) and 20261123090000 (#1061); the charge journal CHECK it requires is in place;
--   * none of the names it introduces exists yet: the six enum types, the nine new enum values, the seventeen columns
--     on ServiceCase / ServiceDevice / ServiceSettings, the two tables, the new CHECKs / keys / index, the eight new
--     functions, the ten new triggers, the six new policies;
--   * the one function it replaces, service_case_guard(), is exactly the foundation text (md5 of its body), plpgsql,
--     SECURITY INVOKER, search_path pg_catalog, public, pg_temp, and runs one enabled trigger (ServiceCase_guard);
--   * the two CHECKs it replaces (ServiceCase_outcome_by_status, ServiceSettingsEvent_fields) are in place;
--   * its premises: the tables and columns its new function bodies read, the composite keys it references (unique), the
--     Service Desk trigger functions it reuses; app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of ServiceCase
--     carries BYPASSRLS or is a superuser (so the counts below see every row);
--   * existing data against every new or widened rule (expected 0 each): cases breaking the widened outcome rule;
--     settings journal rows outside the widened field list; journal rows already carrying one of the six new action /
--     event names. Every other new CHECK reads only new columns (NULL / the constant default on every existing row);
--   * informational: cases, SCHEDULED cases, devices, settings rows, settings journal rows; finished migrations sorting
--     after this one; the total.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk tracks (M1) preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261127090000_service_desk_tracks is NOT recorded'
\echo ' 3 prerequisite 20261126090000_service_desk_case_charge is recorded and finished'
\echo ' 4 prerequisites 20261125090000 and 20261123090000 are recorded and finished (of 2)'
\echo ' 5 the charge journal CHECK ServiceCaseEvent_charge_in_place exists'
\echo ' 6 none of the six new enum types exists yet'
\echo ' 7 none of the nine new enum values exists yet'
\echo ' 8 none of the seventeen new columns exists yet (ServiceCase 12, ServiceDevice 3, ServiceSettings 2)'
\echo ' 9 none of the two tables, two sequences, five indexes exists yet'
\echo '10 none of the new CHECKs / keys exists yet'
\echo '11 none of the eight new functions exists yet'
\echo '12 none of the ten new triggers exists yet'
\echo '13 none of the six new policies exists yet'
\echo '14 service_case_guard(): the foundation text (md5), plpgsql, SECURITY INVOKER, search_path ending in pg_temp'
\echo '15 service_case_guard() runs exactly one enabled trigger: ServiceCase_guard on ServiceCase'
\echo '16 the two CHECKs it replaces are in place (of 2)'
\echo '17 the tables it reads or references exist (of 15)'
\echo '18 the columns its new function bodies read exist (of 12)'
\echo '19 the composite keys it references are unique indexes (of 3)'
\echo '20 the Service Desk trigger functions it reuses exist (of 3)'
\echo '21 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '22 the owner of ServiceCase carries BYPASSRLS or is a superuser'
\echo '23 cases breaking the widened outcome rule (outcome set exactly in READY / WORK_DONE / DELIVERED / CLOSED / ABANDONED / CANCELLED) (expected 0)'
\echo '24 settings journal rows outside the widened field list (1 to 6 names of the six) (expected 0)'
\echo '25 journal rows already carrying one of the six new action / event names (expected 0)'
\echo '26 service cases (informational)'
\echo '27 SCHEDULED cases (informational)'
\echo '28 service devices (informational; each gets subjectKind ITEM)'
\echo '29 service settings rows (informational)'
\echo '30 settings journal rows (informational)'
\echo '31 finished migrations sorting after 20261127090000_service_desk_tracks (informational)'
\echo '32 finished migrations in the ledger (informational)'

WITH fn AS (
  SELECT p.oid, p.prosrc, p.prosecdef, p.prolang, p.prorettype, array_to_string(p.proconfig, ',') AS cfg
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'service_case_guard' AND p.pronargs = 0
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_service_desk_case_charge'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations"
                        WHERE migration_name IN ('20261125090000_service_desk_handover_owner_confirmed', '20261123090000_service_desk_ui_erasure_text')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 2
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_charge_in_place' AND contype = 'c'
                          AND conrelid = to_regclass('public."ServiceCaseEvent"')), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
                          AND typname IN ('ServiceWorkType', 'ServiceLocationKind', 'ServiceSubjectKind', 'ServiceCompletionType',
                                          'ServiceReturnReason', 'ServiceAfterSaleResolution')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE t.typnamespace = 'public'::regnamespace
                          AND (t.typname, e.enumlabel) IN (('ServiceCaseKind', 'REMOTE'), ('ServiceCaseStatus', 'WORK_DONE'), ('ServiceOutcome', 'COMPLETED'),
                                                           ('ServiceCaseAction', 'RESCHEDULE'), ('ServiceCaseAction', 'COMPLETE'), ('ServiceCaseAction', 'CHANGE_DETAILS'),
                                                           ('ServiceEventType', 'case.rescheduled'), ('ServiceEventType', 'case.completed'),
                                                           ('ServiceEventType', 'case.details_changed'))), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
                        WHERE k.relnamespace = 'public'::regnamespace AND NOT a.attisdropped
                          AND ((k.relname = 'ServiceCase' AND a.attname IN ('workType', 'serviceLocation', 'appointmentId', 'siteAddress', 'siteNotes',
                                  'completionType', 'completedAt', 'profileKey', 'profileSnapshot', 'returnReason', 'afterSaleResolution', 'originalSaleRef'))
                            OR (k.relname = 'ServiceDevice' AND a.attname IN ('subjectKind', 'displayName', 'attributes'))
                            OR (k.relname = 'ServiceSettings' AND a.attname IN ('serviceProfileKey', 'profileOverrides')))), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                          AND relname IN ('ServiceCompletion', 'ServiceCaseDetailChange', 'ServiceCompletion_id_seq', 'ServiceCaseDetailChange_id_seq',
                                          'ServiceCase_businessId_appointmentId_key', 'ServiceCompletion_businessId_id_key', 'ServiceCompletion_businessId_caseId_key',
                                          'ServiceCaseDetailChange_businessId_id_key', 'ServiceCaseDetailChange_businessId_caseId_caseVersion_key')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                          AND (conname IN ('ServiceCase_location_matches_kind', 'ServiceCase_after_sale_fields', 'ServiceCase_track_texts',
                                           'ServiceCase_profile_snapshot', 'ServiceCase_completion_stamp', 'ServiceCase_completion_place',
                                           'ServiceCase_completed_not_repair', 'ServiceCase_outcome_by_status_v2', 'ServiceCase_appointment_tenant_fkey',
                                           'ServiceDevice_subject_fields', 'ServiceSettings_profile', 'ServiceSettingsEvent_fields_v2',
                                           'ServiceCaseEvent_tracks_in_place')
                               OR conname LIKE 'ServiceCompletion%' OR conname LIKE 'ServiceCaseDetailChange%')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_tracks_in_erasure', 'service_case_details_journaled', 'service_case_completion_recorded',
                                          'service_completion_guard', 'service_completion_matches_case', 'service_detail_change_guard',
                                          'service_detail_change_matches', 'service_tracks_erase_business')), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServiceCase_details_journaled', 'ServiceCase_completion_recorded',
                          'ServiceCompletion_user_same_business', 'ServiceCompletion_guard', 'ServiceCompletion_no_truncate', 'ServiceCompletion_matches_case',
                          'ServiceCaseDetailChange_user_same_business', 'ServiceCaseDetailChange_guard', 'ServiceCaseDetailChange_no_truncate',
                          'ServiceCaseDetailChange_matches')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_policy WHERE polname IN ('service_completion_tenant_select', 'service_completion_tenant_insert',
                          'service_completion_tenant_update', 'service_detail_change_tenant_select', 'service_detail_change_tenant_insert',
                          'service_detail_change_tenant_update')), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM fn WHERE md5(fn.prosrc) = '3831cf1c584f0d081ca7333535ca15b6' AND NOT fn.prosecdef
                          AND fn.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND fn.prorettype = 'trigger'::regtype
                          AND fn.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_trigger g JOIN fn ON fn.oid = g.tgfoid
                         WHERE g.tgname = 'ServiceCase_guard' AND g.tgrelid = to_regclass('public."ServiceCase"') AND g.tgenabled = 'O')
                     + (SELECT count(*) FROM pg_trigger g JOIN fn ON fn.oid = g.tgfoid
                         WHERE NOT (g.tgname = 'ServiceCase_guard' AND g.tgrelid = to_regclass('public."ServiceCase"'))) * 10, 1
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_constraint WHERE contype = 'c'
                          AND ((conname = 'ServiceCase_outcome_by_status' AND conrelid = to_regclass('public."ServiceCase"'))
                            OR (conname = 'ServiceSettingsEvent_fields' AND conrelid = to_regclass('public."ServiceSettingsEvent"')))), 2
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
                          AND relname IN ('ServiceCase', 'ServiceDevice', 'ServiceSettings', 'ServiceSettingsEvent', 'ServicePart', 'ServiceExternalWork',
                                          'ServiceWarrantyOffer', 'Appointment', 'ServiceCaseEvent', 'ServiceIntakeTermsSnapshot', 'ServiceCaseIntake',
                                          'ServiceQuote', 'ServiceHandover', 'ServiceIntakePhoto', 'Business')), 15
  UNION ALL SELECT 18, (SELECT count(*) FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
                         WHERE k.relnamespace = 'public'::regnamespace AND NOT a.attisdropped
                           AND (k.relname, a.attname) IN (('ServiceCaseIntake', 'signedAt'), ('ServiceWarrantyOffer', 'presentedAt'), ('ServicePart', 'state'),
                                                          ('ServiceQuote', 'state'), ('ServiceCase', 'coverageSource'), ('ServiceCase', 'cancellationRequested'),
                                                          ('Business', 'deletionRequestedAt'), ('Business', 'deletedAt'), ('ServiceIntakeTermsSnapshot', 'caseId'),
                                                          ('ServiceIntakePhoto', 'caseId'), ('ServiceExternalWork', 'caseId'), ('ServiceHandover', 'caseId'))), 12
  UNION ALL SELECT 19, (SELECT count(*) FROM pg_index i JOIN pg_class k ON k.oid = i.indexrelid
                         WHERE k.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indpred IS NULL
                           AND k.relname IN ('ServiceCase_businessId_id_key', 'ServiceCaseEvent_businessId_caseId_seq_key', 'Appointment_id_businessId_key')), 3
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND oid IN (to_regprocedure('public.service_user_same_business()'), to_regprocedure('public.service_journal_truncate_guard()'),
                                      to_regprocedure('public.service_ui_business_writable(integer)'))), 3
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 22, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'ServiceCase' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 23, (SELECT count(*) FROM "ServiceCase"
                         WHERE ("outcome" IS NOT NULL) <> ("status"::text IN ('READY', 'WORK_DONE', 'DELIVERED', 'CLOSED', 'ABANDONED', 'CANCELLED'))), 0
  UNION ALL SELECT 24, (SELECT count(*) FROM "ServiceSettingsEvent"
                         WHERE NOT (cardinality("changedFields") BETWEEN 1 AND 6
                                    AND "changedFields" <@ ARRAY['defaultStaffMemberId', 'warrantyTemplate', 'activeTermsVersionId',
                                                                 'activeStatutoryNoticeVersionId', 'serviceProfileKey', 'profileOverrides']::text[])), 0
  UNION ALL SELECT 25, (SELECT count(*) FROM "ServiceCaseEvent"
                         WHERE "action"::text IN ('RESCHEDULE', 'COMPLETE', 'CHANGE_DETAILS')
                            OR "eventType"::text IN ('case.rescheduled', 'case.completed', 'case.details_changed')), 0
  UNION ALL SELECT 26, (SELECT count(*) FROM "ServiceCase"), NULL
  UNION ALL SELECT 27, (SELECT count(*) FROM "ServiceCase" WHERE "status"::text = 'SCHEDULED'), NULL
  UNION ALL SELECT 28, (SELECT count(*) FROM "ServiceDevice"), NULL
  UNION ALL SELECT 29, (SELECT count(*) FROM "ServiceSettings"), NULL
  UNION ALL SELECT 30, (SELECT count(*) FROM "ServiceSettingsEvent"), NULL
  UNION ALL SELECT 31, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261127090000_service_desk_tracks' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 32, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
