-- ============================================================================
-- daily-tasks-foundation-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261018090000_daily_tasks_foundation   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded and nothing sorting after it was applied first;
--     BY NAME every one of the 182 migrations on main before it is finished, and the ledger holds no
--     other name;
--   * none of the names it introduces exists: five tables, their keys and indexes, the "Task" indexes and
--     constraints, the Supplier key, five types, nine functions, the task_* policies, the role
--     task_maintenance and the daily_tasks flag rows;
--   * "Task" is exactly what the D2 gate (run 38287077419) measured and the owner decided on: 9 columns,
--     no row, FORCE RLS, the single policy p7w1_tenant, no trigger; the privileges it will take back are
--     counted (INFO);
--   * the targets of its composite keys exist: Customer / Lead (sec-C) and Document (businessId, id) unique
--     keys; Business carries deletedAt (the retention functions read it); every key column is integer;
--   * the migration role owns every table it changes (Task, its sequence, Supplier) and every table it
--     references, carries BYPASSRLS (its definer functions run as it, the policy table has no policy) and
--     carries CREATEROLE;
--   * app_runtime is a NOLOGIN NOSUPERUSER NOBYPASSRLS group whose logins are all NOSUPERUSER NOBYPASSRLS;
--     INFO: how many roles are members of the migration role (such a role would reach "Task" around its ACL);
--   * the server is PostgreSQL 15+ (ON ... SET NULL (column) and jsonb_path_exists).
--
-- Checks 26 and 27 run first: the row count of "Task" is taken with row_security = off, so a query that row
-- level security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== daily tasks foundation preflight: legend (n -> check) =='
\echo '26 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '27 V2 row level security is not active on "Task" for the evidence role (runs first)'
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261018090000_daily_tasks_foundation is NOT recorded'
\echo ' 3 L2 every finished migration sorts BEFORE it (nothing later was applied first)'
\echo ' 4 L3 finished migrations (INFO count)'
\echo ' 5 L4 every one of the 182 expected names (main before it) is finished (observed = missing)'
\echo ' 6 L5 no ledger row outside the 182 names (observed = unexpected)'
\echo ' 7 N1 none of the relation names it introduces exists (observed = found)'
\echo ' 8 N2 none of its five types exists (observed = found)'
\echo ' 9 N3 none of its nine functions exists (observed = found)'
\echo '10 N4 no policy named task_* exists on any table (observed = found)'
\echo '11 N5 the role task_maintenance does not exist'
\echo '12 N6 no daily_tasks row in PlatformFeatureDefinition / PlatformFeaturePolicy / BusinessFeatureAccess (observed = rows)'
\echo '13 N7 "Task" has none of the 17 columns it adds (observed = found)'
\echo '14 T1 "Task" has exactly its 9 core_data_layer_v1 columns (observed = columns)'
\echo '15 T2 "Task" holds no row (observed = rows)'
\echo '16 T3 "Task": RLS enabled and forced, exactly one policy, p7w1_tenant (observed = policies)'
\echo '17 T4 "Task" carries no user trigger (observed = triggers)'
\echo '18 T5 INFO: privileges on "Task" and its sequence held by roles other than the owner (observed = role x privilege pairs; the migration takes them back)'
\echo '19 K1 the composite key targets exist: Customer / Lead (businessId, id) constraints, Document (businessId, id) unique index (observed = of 3)'
\echo '20 K2 key columns are integer: id and businessId of Customer, Supplier, Lead, Document and User; Business.id (observed = of 11)'
\echo '21 K3 Business carries deletedAt (observed = columns)'
\echo '22 O1 the migration role owns Task, Task_id_seq, Supplier, Customer, Lead, Document, User, Business and the two flag tables (observed = of 10)'
\echo '23 O2 the migration role carries BYPASSRLS or is a superuser, and carries CREATEROLE'
\echo '24 R1 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS; its logins (migration role excluded) are NOSUPERUSER NOBYPASSRLS (observed = logins)'
\echo '25 R2 INFO: roles that are members of the migration role (observed = members; such a role would reach "Task" around its ACL)'
\echo '28 V3 server is PostgreSQL 15 or newer (observed = major version)'

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

\echo '== preflight checks (1-25, 28) =='
WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
tsk AS (SELECT * FROM rel WHERE nm = 'Task'),
me AS (SELECT oid, rolbypassrls, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
              WHERE m.roleid = (SELECT oid FROM rt) AND r.rolcanlogin AND r.rolname <> current_user),
rel_names(nm) AS (VALUES
  ('TaskSeries'), ('TaskSeries_pkey'), ('TaskSeries_businessId_id_key'), ('TaskSeries_id_seq'),
  ('TaskSourceState'), ('TaskSourceState_pkey'), ('TaskSourceState_id_seq'),
  ('TaskSourceState_businessId_dedupeKey_cycleKey_key'), ('TaskSourceState_closedObservedAt_idx'),
  ('TaskEvent'), ('TaskEvent_pkey'), ('TaskEvent_id_seq'), ('TaskEvent_businessId_idempotencyKey_key'),
  ('TaskEvent_businessId_taskId_idx'), ('TaskEvent_businessId_seriesId_idx'), ('TaskEvent_businessId_occurredAt_idx'),
  ('TaskPreferences'), ('TaskPreferences_pkey'),
  ('TaskRequestLedger'), ('TaskRequestLedger_pkey'), ('TaskRequestLedger_id_seq'),
  ('TaskRequestLedger_businessId_idempotencyKey_key'), ('TaskRequestLedger_createdAt_idx'),
  ('TaskRetentionPolicy'), ('TaskRetentionPolicy_pkey'),
  ('Task_businessId_id_key'), ('Task_seriesId_sequence_key'), ('Task_one_open_per_series'),
  ('Task_businessId_status_dueOn_idx'), ('Supplier_businessId_id_key')),
type_names(nm) AS (VALUES ('TaskOrigin'), ('TaskCloseReason'), ('TaskSeriesRuleKind'), ('TaskEventActor'), ('TaskEventType')),
fn_names(nm) AS (VALUES ('task_user_same_business'), ('task_event_append_only_guard'), ('task_event_truncate_guard'),
  ('task_retention_days'), ('task_retention_purge_request_ledger'), ('task_retention_clear_event_digests'),
  ('task_retention_clear_source_identifiers'), ('task_retention_purge_learning_events'), ('task_retention_purge_source_state')),
new_cols(nm) AS (VALUES ('dueOn'), ('remindAt'), ('closeReason'), ('completedAt'), ('completedByUserId'), ('createdByUserId'),
  ('assigneeUserId'), ('seriesId'), ('sequence'), ('pinnedAt'), ('origin'), ('version'), ('customerId'), ('supplierId'),
  ('leadId'), ('documentId'), ('erasedAt')),
core_cols(nm) AS (VALUES ('id'), ('businessId'), ('title'), ('description'), ('sourceType'), ('status'), ('dueDate'),
  ('createdAt'), ('updatedAt')),
task_cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM tsk) AND a.attnum > 0 AND NOT a.attisdropped),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
owned(nm) AS (VALUES ('Task'), ('Task_id_seq'), ('Supplier'), ('Customer'), ('Lead'), ('Document'), ('User'), ('Business'),
  ('PlatformFeatureDefinition'), ('PlatformFeaturePolicy')),
int_cols(tbl, col) AS (VALUES ('Customer', 'id'), ('Customer', 'businessId'), ('Supplier', 'id'), ('Supplier', 'businessId'),
  ('Lead', 'id'), ('Lead', 'businessId'), ('Document', 'id'), ('Document', 'businessId'), ('User', 'id'), ('User', 'businessId'),
  ('Business', 'id')),
-- every migration directory on main before 20261018090000_daily_tasks_foundation (182)
expected(name) AS (
  VALUES
    ('20260210120000_billing_invoice_profile_fields'),
    ('20260329225659_init'),
    ('20260330142739_core_data_layer_v1'),
    ('20260404180953_add_message_analysis'),
    ('20260404192959_add_strategy_variant_type'),
    ('20260408175347_add_user_foundation'),
    ('20260409200322_add_pricing_engine_models'),
    ('20260409201448_add_pricing_engine_models'),
    ('20260411204133_move_business_fields_to_profile'),
    ('20260411231702_business_profile_v1'),
    ('20260413141745_add_deals'),
    ('20260413160913_collaboration_v2_matching_fields'),
    ('20260414101056_add_revenue_activation_v1'),
    ('20260415141145_add_redeem_engine_and_fix_relations'),
    ('20260416123915_add_content_feedback'),
    ('20260416181707_add_document_engine_v1'),
    ('20260416190435_upgrade_vendor_learning_v2'),
    ('20260421141909_add_usage_model'),
    ('20260423112200_add_inventory_intelligence_v1'),
    ('20260423121208_add_inventory_draft_merge_link'),
    ('20260423230912_add_inventory_alert_types'),
    ('20260424101150_add_external_sales'),
    ('20260424111131_add_inventory_pending_match_relations'),
    ('20260424135210_add_extraction_fields'),
    ('20260424141045_add_category_suggestion'),
    ('20260505101018_add_email_ingestion_models'),
    ('20260505124400_reconcile_schema_history'),
    ('20260506131728_add_offer_image_url'),
    ('20260506151600_add_coupon_public_id'),
    ('20260507141435_add_billing_module'),
    ('20260508123333_add_inventory_item_supplier_name'),
    ('20260510120630_add_financial_event_phase_a'),
    ('20260510140000_billing_business_kind'),
    ('20260510180000_billing_pdf_template_style'),
    ('20260511123000_add_billing_quote_mvp'),
    ('20260512120000_add_pos_api_key'),
    ('20260513120000_add_business_bot_settings'),
    ('20260513193000_add_show_draft_suggestions_in_inbox'),
    ('20260514100000_add_product_link_fields'),
    ('20260514120000_add_content_persistence_models'),
    ('20260517204000_add_billing_immutable_issued_fields'),
    ('20260517223000_add_billing_credit_note_foundation'),
    ('20260518001000_add_billing_audit_events'),
    ('20260526120000_whatsapp_attachment_import'),
    ('20260527120000_platform_admin_foundation'),
    ('20260527140000_product_usage_analytics_foundation'),
    ('20260528120000_platform_feature_access_foundation'),
    ('20260528130000_whatsapp_connection_and_customer_phone_unique'),
    ('20260531120000_conversation_pending_state'),
    ('20260531190000_add_purchase_orders_phase1'),
    ('20260531200000_add_receiving_sessions_phase2'),
    ('20260531210000_add_purchase_order_remaining_decisions_phase3'),
    ('20260601100000_add_cost_layer_basic_phase4'),
    ('20260601120000_appointment_object'),
    ('20260601200000_add_supplier_foundation_phase5a'),
    ('20260603120000_add_supplier_purchase_draft_line_unit_cost'),
    ('20260608120000_add_customer_billing_tax_identity'),
    ('20260609120000_add_business_archive_fields'),
    ('20260610120000_h1b1_billing_fk_restrict'),
    ('20260610130000_authority_foundation_phase_c'),
    ('20260610140000_party_resolution_foundation_t1'),
    ('20260610150000_party_anchor_claim_t2_readiness'),
    ('20260611120000_billing_authority_allocation_projection'),
    ('20260615120000_receipt_payment_doctype_enum'),
    ('20260615120100_receipt_payment_tables'),
    ('20260618120000_add_correction_ledger'),
    ('20260624140000_add_payments_foundation'),
    ('20260624150000_add_cardcom_payment_provider'),
    ('20260624170000_add_business_bot_profile'),
    ('20260624180000_add_bot_goal_selection'),
    ('20260624190000_add_bot_setup_and_knowledge'),
    ('20260625120000_add_activation_and_recommendations'),
    ('20260625130000_add_memory_policy_and_learning'),
    ('20260625140000_add_general_decision_ledger'),
    ('20260625150000_add_ledger_layer_stage'),
    ('20260629120000_add_documents_search_indexes'),
    ('20260629130000_add_payment_audit_event'),
    ('20260630120000_add_business_obligation_domain'),
    ('20260705120000_add_paypal_provider'),
    ('20260705140000_add_learning_capture_gaps'),
    ('20260707120000_add_business_location_hours'),
    ('20260715120000_add_crm_notes'),
    ('20260716120000_add_authority_submission_held'),
    ('20260716120000_add_crm_attachments'),
    ('20260721131204_add_supplier_relation_to_purchase_orders'),
    ('20260724120000_add_customer_lifecycle'),
    ('20260814120000_add_ria_canonical_referent'),
    ('20260815120000_add_ria_policy_lineage'),
    ('20260817120000_add_derivation_policy_substrate'),
    ('20260817130000_add_billing_signature_data_url'),
    ('20260818120000_add_derived_claim_substrate'),
    ('20260818130000_bootstrap_vendor_category_policy_v1'),
    ('20260818140000_add_signed_pdf_artifact'),
    ('20260820120000_add_billing_payment_terms_days'),
    ('20260823120000_add_business_deletion_lifecycle'),
    ('20260824210000_d2_p7_wave1_tenant_rls'),
    ('20260825090000_d2_p7_w2gate_admin_read'),
    ('20260825120000_d2_p7_wave1_businessprofile_rls'),
    ('20260825150000_d2_p7_wave2_tenant_rls'),
    ('20260825200000_d2_p7_wave3_tenant_rls'),
    ('20260826090000_d2_p7_w4a_message_provider_unique'),
    ('20260826120000_documents_dedup_identity'),
    ('20260826150000_d2_p7_w4b_whatsapp_tenant_rls'),
    ('20260826200000_d2_p7_w4c_gmail_tenant_rls'),
    ('20260827090000_d2_p7_w4d_documents_tenant_rls'),
    ('20260830120000_d2_p7_w4ea_payments_tenant_rls'),
    ('20260831090000_leads_w1_core'),
    ('20260831120000_d2_p7_w4eb2_billing_tenant_rls'),
    ('20260831130000_supplier_domain_wiring'),
    ('20260831170000_w25_message_hardening'),
    ('20260901090000_d2_pw2_business_feature_access_rls'),
    ('20260901120000_casa_wave_b_platform_admin_mfa'),
    ('20260902090000_d2_ad2a3_conversation_tenant_coherence'),
    ('20260902100000_auth_token_version'),
    ('20260902120000_d2_cutover2b_pilot_tenant_rls'),
    ('20260903090000_import_run_execution_ledger'),
    ('20260903200000_notification_persistence'),
    ('20260907120000_i8a_historical_fiscal_documents'),
    ('20260908120000_persistent_auth_sessions'),
    ('20260908180000_d2_user_business_privilege_narrowing'),
    ('20260908200000_auth_session_privilege_contract'),
    ('20260909020000_add_payplus_provider'),
    ('20260913120000_authsession_user_agent'),
    ('20260914120000_inbound_email_foundation'),
    ('20260915090000_f01_import_retry_identity'),
    ('20260915120000_businessprofile_runtime_grants'),
    ('20260915130000_add_sumit_provider'),
    ('20260915130100_payment_routing_callback_secret'),
    ('20260916090000_inbound_email_authorized_senders'),
    ('20260917090000_payables_phase_1a_foundation'),
    ('20260917090100_payables_phase_1a_tenant_rls'),
    ('20260917090200_payables_phase_1a_obligation_backfill'),
    ('20260917100000_inbound_address_retirement_and_sender_reregistration'),
    ('20260918090000_payables_phase_2_document_evidence'),
    ('20260918120000_payables_phase_3_cheques_and_bank_accounts'),
    ('20260918140000_inbound_email_challenge_purpose_and_lifecycle'),
    ('20260922090000_c3_payment_accounting_settlement'),
    ('20260922130000_payables_p4_p6_outbound_foundation'),
    ('20260923090000_m0_derived_claim_evidence_link_tenant_fk'),
    ('20260923100000_m2_knowledge_measure'),
    ('20260923110000_m3_business_insight'),
    ('20260924090000_m5_identity_enum_expansion'),
    ('20260924090100_m4_m5_knowledge_expansion'),
    ('20260924180000_m5_collection_action_append_only'),
    ('20260925090000_m55_sensor_fabric'),
    ('20260926090000_m6_temporal_knowledge'),
    ('20260926110000_sec_c_tenant_composite_fk'),
    ('20260926110100_sec_c_bootstrap_lookup_functions'),
    ('20260926110200_sec_c_admin_read_whatsapp_attachment_import'),
    ('20260926110300_sec_c_explicit_identity_grants'),
    ('20260926120000_p0_business_evidence'),
    ('20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events'),
    ('20260927090000_payables_installment_workflow'),
    ('20260927120000_p0_asset_provenance_and_source_lines'),
    ('20260927180000_m2_intake_event'),
    ('20260928090000_m9_outcome_learning'),
    ('20260928120000_p1_business_offering'),
    ('20260929090000_m3_canonical_intake'),
    ('20260929090000_tenant_rls_closure'),
    ('20260930090000_knowledge_derive_authority'),
    ('20261001090000_m4_identity_routing'),
    ('20261002090000_crm_lead_lifecycle'),
    ('20261003090000_control_plane_production_privileges'),
    ('20261004090000_p2_business_identity'),
    ('20261005090000_cost_learning_wave1_policies'),
    ('20261006090000_business_tenant_write_rls'),
    ('20261007090000_cost_learning_wave2_patterns'),
    ('20261008090000_learning_coverage_policies'),
    ('20261008090000_p3a_identity_enum_values'),
    ('20261008090100_p3a_trust_claims'),
    ('20261009090000_m6_acquisition_connections'),
    ('20261010090000_business_brain_temporal_policies'),
    ('20261011090000_onboarding_setup_state'),
    ('20261011090100_signup_consent_business_rename'),
    ('20261011090200_user_email_casefold_unique'),
    ('20261012090000_closed_loop_recommendation_evidence'),
    ('20261013090000_m7a_commerce_telephony_foundation'),
    ('20261013090000_p3e_landing_persistence'),
    ('20261014090000_m7bc_commerce_demand_and_line_labels'),
    ('20261015090000_transactional_email_foundation'),
    ('20261016090000_payments_core_connection_config'),
    ('20261017090000_auth_email_tokens')
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261018090000_daily_tasks_foundation'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261018090000_daily_tasks_foundation')
  UNION ALL SELECT 3, (SELECT max(migration_name) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) < '20261018090000_daily_tasks_foundation', 1
  UNION ALL SELECT 4, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (
                        SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL)),
                      (SELECT count(*) FROM expected e WHERE NOT EXISTS (
                        SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected)),
                      (SELECT count(*) FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM rel WHERE nm IN (SELECT nm FROM rel_names))
                      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN (SELECT nm FROM rel_names)),
                      (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM rel_names))
                      + (SELECT count(*) FROM pg_constraint WHERE conname IN (SELECT nm FROM rel_names))
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname IN (SELECT nm FROM type_names)),
                      (SELECT count(*) FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname IN (SELECT nm FROM type_names))
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN (SELECT nm FROM fn_names)),
                      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname IN (SELECT nm FROM fn_names))
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'task\_%'),
                       (SELECT count(*) FROM pg_policy WHERE polname LIKE 'task\_%')
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'task_maintenance'),
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'task_maintenance')
  UNION ALL SELECT 12, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'daily_tasks')
                       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'daily_tasks')
                       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'daily_tasks') = 0,
                       (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'daily_tasks')
                       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'daily_tasks')
                       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'daily_tasks')
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM task_cols WHERE attname IN (SELECT nm FROM new_cols)),
                       (SELECT count(*) FROM task_cols WHERE attname IN (SELECT nm FROM new_cols))
  UNION ALL SELECT 14, (SELECT count(*) FROM task_cols) = 9 AND NOT EXISTS (SELECT 1 FROM core_cols c WHERE c.nm NOT IN (SELECT attname FROM task_cols)),
                       (SELECT count(*) FROM task_cols)
  UNION ALL SELECT 15, (SELECT count(*) FROM "Task") = 0, (SELECT count(*) FROM "Task")
  UNION ALL SELECT 16, (SELECT relrowsecurity AND relforcerowsecurity FROM tsk) IS TRUE
                       AND (SELECT count(*) FROM pg_policy WHERE polrelid = (SELECT oid FROM tsk)) = 1
                       AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM tsk) AND polname = 'p7w1_tenant'),
                       (SELECT count(*) FROM pg_policy WHERE polrelid = (SELECT oid FROM tsk))
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM tsk) AND NOT tgisinternal) = 0,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM tsk) AND NOT tgisinternal)
  UNION ALL SELECT 18, true,
                       (SELECT count(*) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                         WHERE r.nm IN ('Task', 'Task_id_seq') AND x.grantee <> r.relowner)
  UNION ALL SELECT 19, (SELECT count(*) FROM pg_constraint WHERE contype = 'u'
                          AND conname IN ('Customer_businessId_id_key', 'Lead_businessId_id_key'))
                       + (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                          WHERE r.nm = 'Document_businessId_id_key' AND i.indisunique AND i.indpred IS NULL) = 3,
                       (SELECT count(*) FROM pg_constraint WHERE contype = 'u'
                          AND conname IN ('Customer_businessId_id_key', 'Lead_businessId_id_key'))
                       + (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                          WHERE r.nm = 'Document_businessId_id_key' AND i.indisunique AND i.indpred IS NULL)
  UNION ALL SELECT 20, (SELECT count(*) FROM int_cols ic JOIN rel r ON r.nm = ic.tbl
                          JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = ic.col AND NOT a.attisdropped
                         WHERE a.atttypid = 'integer'::regtype) = 11,
                       (SELECT count(*) FROM int_cols ic JOIN rel r ON r.nm = ic.tbl
                          JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = ic.col AND NOT a.attisdropped
                         WHERE a.atttypid = 'integer'::regtype)
  UNION ALL SELECT 21, EXISTS (SELECT 1 FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
                                WHERE r.nm = 'Business' AND a.attname = 'deletedAt' AND NOT a.attisdropped),
                       (SELECT count(*) FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
                         WHERE r.nm = 'Business' AND a.attname = 'deletedAt' AND NOT a.attisdropped)
  UNION ALL SELECT 22, (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM owned) AND relowner = (SELECT oid FROM me)) = 10,
                       (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM owned) AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 23, (SELECT (rolbypassrls OR rolsuper) AND (rolcreaterole OR rolsuper) FROM me), 1
  UNION ALL SELECT 24, EXISTS (SELECT 1 FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
                       AND EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 25, true,
                       (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM me))
  UNION ALL SELECT 28, current_setting('server_version_num')::int >= 150000, current_setting('server_version_num')::int / 10000
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
