-- ============================================================================
-- service-desk-ui-foundation-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261120090000_service_desk_ui_foundation   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * the migrations it builds on are recorded and finished: 1.2a (20261112090000) and 1.2b (20261113090000), and
--     BOTH migrations that sort before it and are not yet released at the time of writing — the business documents
--     migration 20261114090000 (#980) and M2 20261115090000_service_parts. While either is pending the release
--     gate's PREFIX INVARIANT refuses expected=[this migration] anyway; checks 5 and 6 make that visible first;
--   * none of the names it introduces exists yet: eight tables, ten types, fifteen functions, the feature key;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS;
--   * the three composite keys it references exist (ServiceCase, ServiceQuote by version, StaffMember);
--   * the two foundation functions it reuses exist; Business carries the two deletion columns its guards read;
--   * the owner of Business (the migration role) carries BYPASSRLS or is a superuser;
--   * the number of finished migrations (informational);
--   * the appointments data migration 20261115100000_appointments_open_all (#1001), which sorts between M2 and this
--     migration, is APPLIED in the ledger: one finished, not rolled-back row and no failed or unfinished row for that
--     name (check 17). Its directory on main proves nothing; only the ledger row does. While it is pending the gate's
--     PREFIX INVARIANT refuses expected=[this migration]; check 17 makes that visible first, like checks 5 and 6.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk UI foundation preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261120090000_service_desk_ui_foundation is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 1.2a 20261112090000 and 1.2b 20261113090000 are recorded and finished (of 2)'
\echo ' 5 the business documents migration 20261114090000_business_documents_records (#980) is recorded and finished'
\echo ' 6 M2 20261115090000_service_parts is recorded and finished'
\echo ' 7 none of the eight new tables exists yet'
\echo ' 8 none of the ten new types exists yet'
\echo ' 9 none of the fifteen new functions exists yet'
\echo '10 the feature key service_desk is not defined yet (definition + policy)'
\echo '11 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '12 the composite keys it references exist (of 3)'
\echo '13 the foundation functions it reuses exist (of 2)'
\echo '14 Business carries deletionRequestedAt and deletedAt (of 2)'
\echo '15 the owner of Business carries BYPASSRLS or is a superuser'
\echo '16 finished migrations in the ledger (informational)'
\echo '17 the appointments migration 20261115100000_appointments_open_all (#1001) is applied: finished, not rolled back, no failed row'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261120090000_service_desk_ui_foundation' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN ('20261112090000_service_desk_foundation', '20261113090000_service_external_work')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 2
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_business_documents_records'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('ServiceTextVersion', 'ServiceSettings', 'ServiceIntakeTermsSnapshot', 'ServiceWarrantyOffer', 'ServiceIntakePhoto',
                      'ServiceShareEvent', 'ServicePhoneReminder', 'ServiceStorageErasure')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_type WHERE typname IN ('ServiceTextKind', 'ServiceTextLegalStatus', 'ServiceDurationUnit',
      'ServiceWarrantyOfferState', 'ServiceWarrantyOfferSource', 'ServiceReaffirmMethod', 'ServiceShareObjectKind', 'ServiceShareChannel',
      'ServicePhoneReminderOutcome', 'ServiceStorageErasureState')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_ui_business_writable', 'service_ui_in_erasure', 'service_text_version_guard', 'service_settings_guard',
                      'service_intake_terms_guard', 'service_warranty_end', 'service_warranty_offer_guard', 'service_warranty_chain_check',
                      'service_intake_photo_guard', 'service_share_event_guard', 'service_phone_reminder_guard', 'service_storage_erasure_guard',
                      'service_desk_ui_erase_business', 'service_storage_erasure_due', 'service_storage_erasure_record_pass')), 0
  UNION ALL SELECT 10, (SELECT (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'service_desk')
                             + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_class WHERE relname IN ('ServiceCase_businessId_id_key', 'ServiceQuote_businessId_caseId_version_key',
                                                                         'StaffMember_businessId_id_key')), 3
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business', 'service_journal_truncate_guard')), 2
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND NOT a.attisdropped
                           AND a.attname IN ('deletionRequestedAt', 'deletedAt')), 2
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 16, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
  UNION ALL SELECT 17, (SELECT CASE WHEN
        (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115100000_appointments_open_all'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
    AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115100000_appointments_open_all'
            AND (finished_at IS NULL OR rolled_back_at IS NOT NULL)) = 0
    THEN 1 ELSE 0 END), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
