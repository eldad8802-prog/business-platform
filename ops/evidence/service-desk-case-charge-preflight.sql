-- ============================================================================
-- service-desk-case-charge-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261126090000_service_desk_case_charge   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded;
--   * its prerequisites are recorded and finished: 20261125090000_service_desk_handover_owner_confirmed (#1096), the
--     auth link 20261126090000_auth_issuer_declaration_link (it sorts before this one; the release order applies it
--     first), and the P4 audit journal 20261122090000 + the erasure text 20261123090000 (#1061);
--   * none of the names it introduces exists yet: the three enum types, the six new journal enum values, the two
--     tables with their sequences and indexes, the journal CHECK, the four functions, the six triggers, the five
--     policies (it replaces no existing function: all four are new);
--   * its premises: ServiceCase / ServiceQuote / BillingDocument / Business / User exist; the composite keys it
--     references are unique; the three Service Desk trigger functions it reuses and the P4 journal CHECK exist; the
--     enum types it extends exist;
--   * BillingDocument, from the CATALOG only (no billing row is read): the four columns the link guard reads, the five
--     enum labels it compares to, and app_runtime holding SELECT on it (the guard reads as the caller, under RLS);
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of ServiceCase carries BYPASSRLS or is a superuser
--     (so the counts below see every row);
--   * existing data: no journal row already carries one of the six new action / event names (the new CHECK on
--     ServiceCaseEvent is validated when it is added; expected 0);
--   * informational: cases, journal events, approved quotes; finished migrations sorting after this one; the total.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk case charge preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261126090000_service_desk_case_charge is NOT recorded'
\echo ' 3 prerequisite 20261125090000_service_desk_handover_owner_confirmed is recorded and finished'
\echo ' 4 prerequisite 20261126090000_auth_issuer_declaration_link is recorded and finished (release order: before this one)'
\echo ' 5 prerequisites 20261122090000 (P4 journal) and 20261123090000 are recorded and finished (of 2)'
\echo ' 6 none of the three new enum types exists yet'
\echo ' 7 none of the six new ServiceEventType / ServiceCaseAction values exists yet'
\echo ' 8 none of the two tables, two sequences, five indexes exists yet'
\echo ' 9 none of its CHECKs exists yet (journal CHECK + table CHECKs)'
\echo '10 none of the four functions exists yet (nothing is replaced)'
\echo '11 none of the six triggers exists yet'
\echo '12 none of the five policies exists yet'
\echo '13 the tables it references exist: ServiceCase, ServiceQuote, BillingDocument, Business, User (of 5)'
\echo '14 the composite keys it references are unique indexes (of 2)'
\echo '15 the Service Desk trigger functions it reuses exist (of 3)'
\echo '16 the P4 journal CHECK ServiceCaseEvent_record_in_place exists'
\echo '17 the enum types it extends or uses exist: ServiceEventType, ServiceCaseAction, ServiceActor with OWNER_USER (of 3)'
\echo '18 BillingDocument (catalog): the four columns the link guard reads exist (of 4)'
\echo '19 BillingDocument (catalog): the five enum labels the link guard compares to exist (of 5)'
\echo '20 app_runtime holds SELECT on BillingDocument (catalog privilege; the guard reads as the caller)'
\echo '21 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '22 the owner of ServiceCase carries BYPASSRLS or is a superuser'
\echo '23 journal rows already carrying one of the six new action / event names (expected 0)'
\echo '24 service cases (informational)'
\echo '25 case journal events (informational)'
\echo '26 approved quotes (informational)'
\echo '27 finished migrations sorting after 20261126090000_service_desk_case_charge (informational)'
\echo '28 finished migrations in the ledger (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_service_desk_case_charge'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations"
                        WHERE migration_name IN ('20261122090000_service_desk_audit_journal', '20261123090000_service_desk_ui_erasure_text')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 2
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
                          AND typname IN ('ServiceChargeMode', 'ServiceChargeSource', 'ServiceBillingLinkRole')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE t.typnamespace = 'public'::regnamespace
                          AND ((t.typname = 'ServiceEventType' AND e.enumlabel IN ('charge.recorded', 'billing.linked', 'billing.unlinked'))
                            OR (t.typname = 'ServiceCaseAction' AND e.enumlabel IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')))), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                          AND relname IN ('ServiceCaseCharge', 'ServiceCaseBillingLink', 'ServiceCaseCharge_id_seq', 'ServiceCaseBillingLink_id_seq',
                                          'ServiceCaseCharge_businessId_id_key', 'ServiceCaseCharge_businessId_caseId_seq_key',
                                          'ServiceCaseBillingLink_businessId_id_key', 'ServiceCaseBillingLink_one_active_per_document',
                                          'ServiceCaseBillingLink_businessId_caseId_idx')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                          AND (conname = 'ServiceCaseEvent_charge_in_place' OR conname LIKE 'ServiceCaseCharge%' OR conname LIKE 'ServiceCaseBillingLink%')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_charge_in_erasure', 'service_case_charge_guard', 'service_case_billing_link_guard',
                                          'service_case_charge_erase_business')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServiceCaseCharge_user_same_business', 'ServiceCaseBillingLink_user_same_business',
                          'ServiceCaseCharge_guard', 'ServiceCaseCharge_no_truncate', 'ServiceCaseBillingLink_guard', 'ServiceCaseBillingLink_no_truncate')), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_policy WHERE polname IN ('service_case_charge_tenant_select', 'service_case_charge_tenant_insert',
                          'service_case_billing_link_tenant_select', 'service_case_billing_link_tenant_insert', 'service_case_billing_link_tenant_update')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
                          AND relname IN ('ServiceCase', 'ServiceQuote', 'BillingDocument', 'Business', 'User')), 5
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_index i JOIN pg_class k ON k.oid = i.indexrelid
                         WHERE k.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indpred IS NULL
                           AND k.relname IN ('ServiceCase_businessId_id_key', 'ServiceQuote_businessId_caseId_version_key')), 2
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND oid IN (to_regprocedure('public.service_user_same_business()'), to_regprocedure('public.service_journal_truncate_guard()'),
                                      to_regprocedure('public.service_ui_business_writable(integer)'))), 3
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place' AND contype = 'c'
                          AND conrelid = to_regclass('public."ServiceCaseEvent"')), 1
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
                          AND typname IN ('ServiceEventType', 'ServiceCaseAction'))
                     + (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                         WHERE t.typnamespace = 'public'::regnamespace AND t.typname = 'ServiceActor' AND e.enumlabel = 'OWNER_USER'), 3
  UNION ALL SELECT 18, (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('public."BillingDocument"') AND NOT attisdropped
                          AND attname IN ('id', 'businessId', 'documentType', 'status')), 4
  UNION ALL SELECT 19, (SELECT count(*) FROM pg_enum e JOIN pg_attribute a ON a.atttypid = e.enumtypid
                         WHERE a.attrelid = to_regclass('public."BillingDocument"') AND NOT a.attisdropped
                           AND ((a.attname = 'documentType' AND e.enumlabel IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE'))
                             OR (a.attname = 'status' AND e.enumlabel = 'ISSUED'))), 5
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_class WHERE oid = to_regclass('public."BillingDocument"')
                          AND has_table_privilege('app_runtime', oid, 'SELECT')), 1
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 22, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'ServiceCase' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 23, (SELECT count(*) FROM "ServiceCaseEvent"
                         WHERE "action"::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')
                            OR "eventType"::text IN ('charge.recorded', 'billing.linked', 'billing.unlinked')), 0
  UNION ALL SELECT 24, (SELECT count(*) FROM "ServiceCase"), NULL
  UNION ALL SELECT 25, (SELECT count(*) FROM "ServiceCaseEvent"), NULL
  UNION ALL SELECT 26, (SELECT count(*) FROM "ServiceQuote" WHERE "state" = 'APPROVED'), NULL
  UNION ALL SELECT 27, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261126090000_service_desk_case_charge' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 28, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
