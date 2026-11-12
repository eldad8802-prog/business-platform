-- ============================================================================
-- service-desk-tracks-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261127090000_service_desk_tracks (M1) was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the six enum types with their exact labels in order; the nine new enum values;
--   * the seventeen new columns with their exact types; all nullable except ServiceDevice.subjectKind (NOT NULL,
--     default ITEM);
--   * the nineteen new CHECKs exist and are validated (every existing row passes them); the two replaced CHECKs
--     (ServiceCase_outcome_by_status, ServiceSettingsEvent_fields) are gone;
--   * the two tables with ENABLE + FORCE row-level security; exactly the six per-operation policies, none for removal;
--   * the five new indexes (unique; the appointment one partial); the nine new foreign keys by name, the three user keys
--     setting NULL when the user goes, the detail-change journal key DEFERRABLE INITIALLY DEFERRED;
--   * the ten new triggers by name, function and enabled state, the four constraint triggers deferred; ServiceCase_guard
--     still runs service_case_guard();
--   * the nine functions (eight new, service_case_guard replaced): the exact reviewed text (md5 of the body), search_path
--     pg_catalog, public, pg_temp; exactly one SECURITY DEFINER (the erase), owned by the ServiceCase owner who carries
--     BYPASSRLS or is a superuser; none executable by PUBLIC; app_runtime executes exactly the erase and the
--     erasure-marker helper;
--   * app_runtime rights, read from the ACL letters: both tables exactly ar (read, append), both sequences exactly rU;
--     no other grantee on the four relations;
--   * data invariants: every completion has its case CLOSED with the same completion type; every completion stamp on a
--     case has its completion record; no completion approver other than its actor; every detail record has its
--     CHANGE_DETAILS journal event;
--   * informational counts: completions, detail records, cases with an explicit work type, WORK_DONE cases.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk tracks (M1) evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the six enum types exist with their exact labels in order (of 6)'
\echo ' 4 the nine new enum values exist (of 9)'
\echo ' 5 the seventeen new columns with their exact type and nullability (of 17)'
\echo ' 6 ServiceDevice.subjectKind defaults to ITEM'
\echo ' 7 the nineteen new CHECKs exist and are validated (of 19)'
\echo ' 8 the two replaced CHECKs are gone (expected 0)'
\echo ' 9 both tables ENABLE + FORCE row-level security (of 2)'
\echo '10 exactly the six per-operation policies (6; any other policy counts 10)'
\echo '11 the five new unique indexes, the appointment one partial (of 5)'
\echo '12 the nine new foreign keys exist (of 9)'
\echo '13 the three user foreign keys of the two tables set NULL when the user goes (of 3)'
\echo '14 the detail-change journal key is DEFERRABLE INITIALLY DEFERRED'
\echo '15 the ten new triggers exist on their function and are enabled (of 10)'
\echo '16 the four constraint triggers are DEFERRABLE INITIALLY DEFERRED (of 4)'
\echo '17 ServiceCase_guard still runs service_case_guard() and is enabled'
\echo '18 the nine functions carry the exact reviewed text (md5 of the body) (of 9)'
\echo '19 the nine functions run with search_path pg_catalog, public, pg_temp (of 9)'
\echo '20 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '21 the erase is owned by the ServiceCase owner, who carries BYPASSRLS or is a superuser'
\echo '22 none of the nine executable by PUBLIC (expected 0)'
\echo '23 app_runtime executes exactly the erase and the erasure-marker helper (2; any other counts 10)'
\echo '24 app_runtime ACL letters on both tables: ar (of 2)'
\echo '25 app_runtime ACL letters on both sequences: rU (of 2)'
\echo '26 any other grantee on the two tables or their sequences (expected 0)'
\echo '27 completions whose case is not CLOSED with the same completion type (expected 0)'
\echo '28 cases with a completion stamp and no completion record of that type (expected 0)'
\echo '29 completions whose debt approver is not the actor (expected 0)'
\echo '30 detail records without their CHANGE_DETAILS journal event (expected 0)'
\echo '31 completions (informational)'
\echo '32 detail records (informational)'
\echo '33 cases with an explicit work type (informational)'
\echo '34 WORK_DONE cases (informational)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.prosrc, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.pronargs <= 1
     AND p.proname IN ('service_tracks_in_erasure', 'service_case_guard', 'service_case_details_journaled', 'service_case_completion_recorded',
                       'service_completion_guard', 'service_completion_matches_case', 'service_detail_change_guard',
                       'service_detail_change_matches', 'service_tracks_erase_business')
), t AS (
  SELECT k.oid, k.relname, k.relowner, k.relacl FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace
     AND k.relname IN ('ServiceCompletion', 'ServiceCaseDetailChange', 'ServiceCompletion_id_seq', 'ServiceCaseDetailChange_id_seq')
), e AS (
  SELECT ty.typname, string_agg(en.enumlabel, ',' ORDER BY en.enumsortorder) AS labels
    FROM pg_type ty JOIN pg_enum en ON en.enumtypid = ty.oid
   WHERE ty.typnamespace = 'public'::regnamespace
     AND ty.typname IN ('ServiceWorkType', 'ServiceLocationKind', 'ServiceSubjectKind', 'ServiceCompletionType', 'ServiceReturnReason',
                        'ServiceAfterSaleResolution')
   GROUP BY ty.typname
), col AS (
  SELECT k.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull, a.attnum, a.attrelid
    FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
   WHERE k.relnamespace = 'public'::regnamespace AND NOT a.attisdropped AND k.relname IN ('ServiceCase', 'ServiceDevice', 'ServiceSettings')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
               + (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks'
                     AND (finished_at IS NULL OR rolled_back_at IS NOT NULL)) * 10 AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM e WHERE (typname, labels) IN (
                          ('ServiceWorkType', 'REPAIR,MAINTENANCE,INSTALLATION,INSPECTION,PROFESSIONAL,REMOTE_SUPPORT,AFTER_SALE'),
                          ('ServiceLocationKind', 'AT_BUSINESS,AT_CUSTOMER,FIELD_SITE,REMOTE'),
                          ('ServiceSubjectKind', 'ITEM,VEHICLE,SYSTEM,NONE'),
                          ('ServiceCompletionType', 'OWNER_CONFIRMED_ON_SITE,OWNER_CONFIRMED_REMOTE,OWNER_CONFIRMED_AT_BUSINESS'),
                          ('ServiceReturnReason', 'DEFECT,NOT_AS_DESCRIBED,WRONG_ITEM,CHANGE_OF_MIND,LEGAL_CANCELLATION,OTHER'),
                          ('ServiceAfterSaleResolution', 'REPAIR,EXCHANGE,CREDIT,RETURN_ORIGINAL'))), 6
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid
                        WHERE ty.typnamespace = 'public'::regnamespace
                          AND (ty.typname, en.enumlabel) IN (('ServiceCaseKind', 'REMOTE'), ('ServiceCaseStatus', 'WORK_DONE'), ('ServiceOutcome', 'COMPLETED'),
                                                             ('ServiceCaseAction', 'RESCHEDULE'), ('ServiceCaseAction', 'COMPLETE'), ('ServiceCaseAction', 'CHANGE_DETAILS'),
                                                             ('ServiceEventType', 'case.rescheduled'), ('ServiceEventType', 'case.completed'),
                                                             ('ServiceEventType', 'case.details_changed'))), 9
  UNION ALL SELECT 5, (SELECT count(*) FROM col WHERE (relname, attname, typ, attnotnull) IN (
                          ('ServiceCase', 'workType', '"ServiceWorkType"', false), ('ServiceCase', 'serviceLocation', '"ServiceLocationKind"', false),
                          ('ServiceCase', 'appointmentId', 'integer', false), ('ServiceCase', 'siteAddress', 'text', false),
                          ('ServiceCase', 'siteNotes', 'text', false), ('ServiceCase', 'completionType', '"ServiceCompletionType"', false),
                          ('ServiceCase', 'completedAt', 'timestamp(3) without time zone', false), ('ServiceCase', 'profileKey', 'text', false),
                          ('ServiceCase', 'profileSnapshot', 'jsonb', false), ('ServiceCase', 'returnReason', '"ServiceReturnReason"', false),
                          ('ServiceCase', 'afterSaleResolution', '"ServiceAfterSaleResolution"', false), ('ServiceCase', 'originalSaleRef', 'text', false),
                          ('ServiceDevice', 'subjectKind', '"ServiceSubjectKind"', true), ('ServiceDevice', 'displayName', 'text', false),
                          ('ServiceDevice', 'attributes', 'jsonb', false),
                          ('ServiceSettings', 'serviceProfileKey', 'text', false), ('ServiceSettings', 'profileOverrides', 'jsonb', false))), 17
  UNION ALL SELECT 6, (SELECT count(*) FROM col JOIN pg_attrdef d ON d.adrelid = col.attrelid AND d.adnum = col.attnum
                        WHERE col.relname = 'ServiceDevice' AND col.attname = 'subjectKind' AND pg_get_expr(d.adbin, d.adrelid) LIKE '''ITEM''::%'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint k JOIN pg_class r ON r.oid = k.conrelid
                        WHERE k.contype = 'c' AND k.convalidated AND r.relnamespace = 'public'::regnamespace
                          AND (r.relname, k.conname) IN (
                            ('ServiceCase', 'ServiceCase_location_matches_kind'), ('ServiceCase', 'ServiceCase_after_sale_fields'),
                            ('ServiceCase', 'ServiceCase_track_texts'), ('ServiceCase', 'ServiceCase_profile_snapshot'),
                            ('ServiceCase', 'ServiceCase_completion_stamp'), ('ServiceCase', 'ServiceCase_completion_place'),
                            ('ServiceCase', 'ServiceCase_completed_not_repair'), ('ServiceCase', 'ServiceCase_outcome_by_status_v2'),
                            ('ServiceDevice', 'ServiceDevice_subject_fields'), ('ServiceSettings', 'ServiceSettings_profile'),
                            ('ServiceSettingsEvent', 'ServiceSettingsEvent_fields_v2'), ('ServiceCaseEvent', 'ServiceCaseEvent_tracks_in_place'),
                            ('ServiceCompletion', 'ServiceCompletion_texts'), ('ServiceCompletion', 'ServiceCompletion_balance'),
                            ('ServiceCompletion', 'ServiceCompletion_debt_decided'), ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_version'),
                            ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_fields'), ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_fields_match'),
                            ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_texts'))), 19
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                          AND conname IN ('ServiceCase_outcome_by_status', 'ServiceSettingsEvent_fields')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceCompletion', 'ServiceCaseDetailChange')
                          AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid
                         WHERE (t.relname, p.polname, p.polcmd) IN (('ServiceCompletion', 'service_completion_tenant_select', 'r'),
                                                                    ('ServiceCompletion', 'service_completion_tenant_insert', 'a'),
                                                                    ('ServiceCompletion', 'service_completion_tenant_update', 'w'),
                                                                    ('ServiceCaseDetailChange', 'service_detail_change_tenant_select', 'r'),
                                                                    ('ServiceCaseDetailChange', 'service_detail_change_tenant_insert', 'a'),
                                                                    ('ServiceCaseDetailChange', 'service_detail_change_tenant_update', 'w'))
                           AND p.polpermissive AND p.polroles = '{0}')
                     + (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid
                         WHERE (t.relname, p.polname) NOT IN (('ServiceCompletion', 'service_completion_tenant_select'),
                                                              ('ServiceCompletion', 'service_completion_tenant_insert'),
                                                              ('ServiceCompletion', 'service_completion_tenant_update'),
                                                              ('ServiceCaseDetailChange', 'service_detail_change_tenant_select'),
                                                              ('ServiceCaseDetailChange', 'service_detail_change_tenant_insert'),
                                                              ('ServiceCaseDetailChange', 'service_detail_change_tenant_update'))) * 10, 6
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_index i JOIN pg_class k ON k.oid = i.indexrelid
                         WHERE k.relnamespace = 'public'::regnamespace AND i.indisunique
                           AND (k.relname, i.indpred IS NOT NULL) IN (('ServiceCase_businessId_appointmentId_key', true),
                                                                      ('ServiceCompletion_businessId_id_key', false), ('ServiceCompletion_businessId_caseId_key', false),
                                                                      ('ServiceCaseDetailChange_businessId_id_key', false),
                                                                      ('ServiceCaseDetailChange_businessId_caseId_caseVersion_key', false))), 5
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
                          AND conname IN ('ServiceCase_appointment_tenant_fkey', 'ServiceCompletion_businessId_fkey', 'ServiceCompletion_case_tenant_fkey',
                                          'ServiceCompletion_actorUserId_fkey', 'ServiceCompletion_debtApprovedByUserId_fkey',
                                          'ServiceCaseDetailChange_businessId_fkey', 'ServiceCaseDetailChange_case_tenant_fkey',
                                          'ServiceCaseDetailChange_event_fkey', 'ServiceCaseDetailChange_actorUserId_fkey')), 9
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'
                          AND k.confrelid = to_regclass('public."User"') AND k.confdeltype = 'n'), 3
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conname = 'ServiceCaseDetailChange_event_fkey'
                          AND confrelid = to_regclass('public."ServiceCaseEvent"') AND condeferrable AND condeferred), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
                         WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND r.relnamespace = 'public'::regnamespace
                           AND (r.relname, g.tgname, p.proname) IN (
                             ('ServiceCase', 'ServiceCase_details_journaled', 'service_case_details_journaled'),
                             ('ServiceCase', 'ServiceCase_completion_recorded', 'service_case_completion_recorded'),
                             ('ServiceCompletion', 'ServiceCompletion_user_same_business', 'service_user_same_business'),
                             ('ServiceCompletion', 'ServiceCompletion_guard', 'service_completion_guard'),
                             ('ServiceCompletion', 'ServiceCompletion_no_truncate', 'service_journal_truncate_guard'),
                             ('ServiceCompletion', 'ServiceCompletion_matches_case', 'service_completion_matches_case'),
                             ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_user_same_business', 'service_user_same_business'),
                             ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_guard', 'service_detail_change_guard'),
                             ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_no_truncate', 'service_journal_truncate_guard'),
                             ('ServiceCaseDetailChange', 'ServiceCaseDetailChange_matches', 'service_detail_change_matches'))), 10
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_trigger WHERE tgconstraint <> 0 AND tgdeferrable AND tginitdeferred
                          AND tgname IN ('ServiceCase_details_journaled', 'ServiceCase_completion_recorded', 'ServiceCompletion_matches_case',
                                         'ServiceCaseDetailChange_matches')), 4
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_trigger g JOIN f ON f.oid = g.tgfoid
                         WHERE g.tgname = 'ServiceCase_guard' AND g.tgrelid = to_regclass('public."ServiceCase"') AND g.tgenabled = 'O'
                           AND f.proname = 'service_case_guard'), 1
  UNION ALL SELECT 18, (SELECT count(*) FROM f WHERE (proname, md5(prosrc)) IN (
                          ('service_tracks_in_erasure', '85ef19ca22edfe03d3b8dfa9125a7a04'), ('service_case_guard', 'cf4b5309371f12b356fd394e41540cf9'),
                          ('service_case_details_journaled', 'b4c9c075909c21b6e717af20c13bfa76'),
                          ('service_case_completion_recorded', 'e2b7c826d6c2c7e2634919d4c5717117'),
                          ('service_completion_guard', '7c66cf96119721e9b74967ffcacdfdbd'),
                          ('service_completion_matches_case', '114a6c85c421fcc7b2bb1e7d29e6a7d2'),
                          ('service_detail_change_guard', '2f4454a80b6b50a118e48cb2b6f437fb'),
                          ('service_detail_change_matches', '6caf46ec0c444c27b8a0c365ad846f7b'),
                          ('service_tracks_erase_business', '8abd2593913a821a6c4e9d1ffa27a74d'))), 9
  UNION ALL SELECT 19, (SELECT count(*) FROM f WHERE cfg = 'search_path=pg_catalog, public, pg_temp'), 9
  UNION ALL SELECT 20, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_tracks_erase_business')
                     + (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_tracks_erase_business') * 10, 1
  UNION ALL SELECT 21, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner
                         WHERE f.proname = 'service_tracks_erase_business' AND (r.rolbypassrls OR r.rolsuper)
                           AND f.proowner = (SELECT relowner FROM pg_class WHERE oid = to_regclass('public."ServiceCase"'))), 1
  UNION ALL SELECT 22, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 23, (SELECT count(*) FROM f WHERE proname IN ('service_tracks_erase_business', 'service_tracks_in_erasure')
                          AND has_function_privilege('app_runtime', oid, 'EXECUTE'))
                     + (SELECT count(*) FROM f WHERE proname NOT IN ('service_tracks_erase_business', 'service_tracks_in_erasure')
                          AND has_function_privilege('app_runtime', oid, 'EXECUTE')) * 10, 2
  UNION ALL SELECT 24, (SELECT count(*) FROM t CROSS JOIN LATERAL unnest(t.relacl) a
                         WHERE t.relname IN ('ServiceCompletion', 'ServiceCaseDetailChange') AND split_part(a::text, '/', 1) = 'app_runtime=ar'), 2
  UNION ALL SELECT 25, (SELECT count(*) FROM t CROSS JOIN LATERAL unnest(t.relacl) a
                         WHERE t.relname IN ('ServiceCompletion_id_seq', 'ServiceCaseDetailChange_id_seq') AND split_part(a::text, '/', 1) = 'app_runtime=rU'), 2
  UNION ALL SELECT 26, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
                         WHERE x.grantee <> t.relowner AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) <> 'app_runtime')), 0
  UNION ALL SELECT 27, (SELECT count(*) FROM "ServiceCompletion" k WHERE NOT EXISTS (SELECT 1 FROM "ServiceCase" s
                          WHERE s."businessId" = k."businessId" AND s."id" = k."caseId" AND s."status"::text = 'CLOSED' AND s."completionType" = k."completionType")), 0
  UNION ALL SELECT 28, (SELECT count(*) FROM "ServiceCase" s WHERE s."completionType" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ServiceCompletion" k
                          WHERE k."businessId" = s."businessId" AND k."caseId" = s."id" AND k."completionType" = s."completionType")), 0
  UNION ALL SELECT 29, (SELECT count(*) FROM "ServiceCompletion" WHERE "debtApprovedByUserId" IS NOT NULL AND "debtApprovedByUserId" IS DISTINCT FROM "actorUserId"), 0
  UNION ALL SELECT 30, (SELECT count(*) FROM "ServiceCaseDetailChange" d WHERE NOT EXISTS (SELECT 1 FROM "ServiceCaseEvent" ev
                          WHERE ev."businessId" = d."businessId" AND ev."caseId" = d."caseId" AND ev."seq" = d."caseVersion" AND ev."action"::text = 'CHANGE_DETAILS')), 0
  UNION ALL SELECT 31, (SELECT count(*) FROM "ServiceCompletion"), NULL
  UNION ALL SELECT 32, (SELECT count(*) FROM "ServiceCaseDetailChange"), NULL
  UNION ALL SELECT 33, (SELECT count(*) FROM "ServiceCase" WHERE "workType" IS NOT NULL), NULL
  UNION ALL SELECT 34, (SELECT count(*) FROM "ServiceCase" WHERE "status"::text = 'WORK_DONE'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
