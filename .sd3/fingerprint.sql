-- LAB ONLY. One hash per object class over everything that is NOT created by 20261120090000_service_desk_ui_foundation:
-- functions (definition + ACL), constraints, policies, triggers, table / sequence ACLs, columns, indexes, enum values
-- and the feature rows other than service_desk. Equal before and after the deploy ⇒ the migration changed no existing
-- object (expand-only). The new objects are excluded by name.
\set ON_ERROR_STOP 1
WITH newt(n) AS (VALUES ('ServiceTextVersion'), ('ServiceSettings'), ('ServiceIntakeTermsSnapshot'), ('ServiceWarrantyOffer'),
  ('ServiceIntakePhoto'), ('ServiceShareEvent'), ('ServicePhoneReminder'), ('ServiceStorageErasure'),
  ('ServiceTextVersion_id_seq'), ('ServiceIntakeTermsSnapshot_id_seq'), ('ServiceWarrantyOffer_id_seq'), ('ServiceIntakePhoto_id_seq'),
  ('ServiceShareEvent_id_seq'), ('ServicePhoneReminder_id_seq')),
newf(n) AS (VALUES ('service_ui_business_writable'), ('service_ui_in_erasure'), ('service_text_version_guard'), ('service_settings_guard'),
  ('service_intake_terms_guard'), ('service_warranty_end'), ('service_warranty_offer_guard'), ('service_warranty_chain_check'),
  ('service_intake_photo_guard'), ('service_share_event_guard'), ('service_phone_reminder_guard'), ('service_storage_erasure_guard'),
  ('service_desk_ui_erase_business'), ('service_storage_erasure_due'), ('service_storage_erasure_record_pass')),
newty(n) AS (VALUES ('ServiceTextKind'), ('ServiceTextLegalStatus'), ('ServiceDurationUnit'), ('ServiceWarrantyOfferState'),
  ('ServiceWarrantyOfferSource'), ('ServiceReaffirmMethod'), ('ServiceShareObjectKind'), ('ServiceShareChannel'),
  ('ServicePhoneReminderOutcome'), ('ServiceStorageErasureState')),
parts AS (
  SELECT 'functions' AS k, md5(string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || COALESCE(p.proacl::text, ''), '|' ORDER BY p.oid::regprocedure::text)) AS h
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.proname NOT IN (SELECT n FROM newf)
  UNION ALL SELECT 'constraints', md5(string_agg(c.conrelid::regclass::text || c.conname || pg_get_constraintdef(c.oid), '|' ORDER BY c.conrelid::regclass::text, c.conname))
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'public'::regnamespace AND r.relname NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'policies', md5(string_agg(tablename || policyname || cmd || COALESCE(qual, '') || COALESCE(with_check, '') || roles::text, '|' ORDER BY tablename, policyname))
    FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'triggers', md5(string_agg(pg_get_triggerdef(t.oid) || t.tgenabled::text, '|' ORDER BY r.relname, t.tgname))
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal AND r.relnamespace = 'public'::regnamespace AND r.relname NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'acls+rls', md5(string_agg(r.relname || COALESCE(r.relacl::text, '') || r.relrowsecurity::text || r.relforcerowsecurity::text, '|' ORDER BY r.relname))
    FROM pg_class r WHERE r.relnamespace = 'public'::regnamespace AND r.relkind IN ('r', 'S', 'v', 'p') AND r.relname NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'columns', md5(string_agg(table_name || column_name || data_type || is_nullable || COALESCE(column_default, ''), '|' ORDER BY table_name, ordinal_position))
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'indexes', md5(string_agg(indexdef, '|' ORDER BY tablename, indexname))
    FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT IN (SELECT n FROM newt)
  UNION ALL SELECT 'enums', md5(string_agg(t.typname || e.enumlabel || e.enumsortorder::text, '|' ORDER BY t.typname, e.enumsortorder))
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname NOT IN (SELECT n FROM newty)
  UNION ALL SELECT 'feature-rows', md5(COALESCE(string_agg(d."key" || d."defaultEnabled"::text || COALESCE(p."globalEnabled"::text, '-'), '|' ORDER BY d."key"), ''))
    FROM "PlatformFeatureDefinition" d LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" <> 'service_desk'
)
SELECT k || '=' || h FROM parts ORDER BY k;
