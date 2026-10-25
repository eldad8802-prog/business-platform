-- ============================================================================
-- oauth-identity-preflight.sql
--
-- Read-only PREFLIGHT for migration
--   20261030090000_oauth_identity_foundation   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded and nothing sorting after it was applied first;
--     BY NAME every one of the 189 migrations on main before it is finished, and the ledger holds no other
--     name — so the release applies exactly this one migration and nothing else is pending before it;
--   * none of the names it creates exists: two tables, their keys, six indexes, the identity sequence, the
--     two policies, the six functions;
--   * what the functions touch exists with the expected shape: User.id / User.businessId / Business.id are
--     integer keys, User.password is NOT NULL today, User.emailVerifiedAt exists (20261017090000 applied),
--     and the migration role owns User and Business (the SECURITY DEFINER functions run as that role);
--   * app_runtime and app_auth exist as NOLOGIN NOSUPERUSER NOBYPASSRLS groups; every login in them (the
--     migration role excluded) is NOSUPERUSER NOBYPASSRLS, so FORCE RLS binds every application path;
--   * app_auth holds NO change privilege on User.password or User.emailVerifiedAt today;
--   * the migration role's default privileges on functions name no grantee (EXECUTE is named explicitly);
--   * the server supports what the migration uses (gen_random_uuid(), hashtextextended(), sha256());
--   * the migration role carries BYPASSRLS (or is a superuser).
--
-- The by-name list is a premise of Production's ledger: a lab built from part of the history cannot meet
-- check 4, and the lab workflow asserts that only 4 fails there. If another migration reaches main before
-- this one is applied, the list (and this file) must be regenerated and the preflight run again.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== oauth identity preflight: legend (n -> check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261030090000_oauth_identity_foundation is NOT recorded'
\echo ' 3 L2 every finished migration sorts BEFORE it (nothing later was applied first)'
\echo ' 4 L3 every one of the 189 migrations on main before it is finished (observed = missing)'
\echo ' 5 L4 no ledger row outside those 189 names (observed = unexpected)'
\echo ' 6 N1 none of the relation names it creates exists (observed = found)'
\echo ' 7 N2 none of its six functions exists (observed = found)'
\echo ' 8 N3 no policy named user_identity_* exists (observed = found)'
\echo ' 9 F1 User.id, User.businessId, Business.id integer; User.password NOT NULL; User.emailVerifiedAt present'
\echo '10 F2 the migration role owns User and Business (observed = of 2)'
\echo '11 R1 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '12 R2 app_auth exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 R3 logins in app_runtime / app_auth (migration role excluded) are NOSUPERUSER NOBYPASSRLS (observed = others)'
\echo '14 A1 app_auth holds no change privilege on User.password or User.emailVerifiedAt'
\echo '15 D1 default privileges (migration role, functions): no grantee at all (observed = grantees)'
\echo '16 V1 server provides gen_random_uuid(), hashtextextended(), sha256() (observed = of 3)'
\echo '17 O1 the migration role carries BYPASSRLS or is a superuser'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
me AS (SELECT oid, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user),
rel_names(nm) AS (VALUES ('UserIdentity'), ('UserIdentity_pkey'), ('UserIdentity_id_seq'),
  ('UserIdentity_provider_providerSubject_key'), ('UserIdentity_userId_provider_key'), ('UserIdentity_businessId_idx'),
  ('OAuthSignupTicket'), ('OAuthSignupTicket_pkey'), ('OAuthSignupTicket_secretHash_key'),
  ('OAuthSignupTicket_provider_providerSubject_purpose_issuedAt_idx'), ('OAuthSignupTicket_expiresAt_idx')),
fn_names(nm) AS (VALUES ('auth_oauth_ticket_issue'), ('auth_oauth_ticket_read'), ('auth_oauth_ticket_consume'),
  ('auth_oauth_identity_attach'), ('auth_oauth_identity_resolve'), ('auth_oauth_ticket_purge')),
usr AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
biz AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
col AS (SELECT c.relname, a.attname, a.atttypid, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.oid IN ((SELECT oid FROM usr), (SELECT oid FROM biz)) AND a.attnum > 0 AND NOT a.attisdropped),
groups AS (SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_auth')),
members AS (SELECT m.member FROM pg_auth_members m WHERE m.roleid IN (SELECT oid FROM groups)),
-- every migration directory on main before 20261030090000_oauth_identity_foundation (189)
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
    ('20261017090000_auth_email_tokens'),
    ('20261018090000_daily_tasks_foundation'),
    ('20261022090000_task_reminders_push'),
    ('20261024090000_platform_admin_a1'),
    ('20261027090000_accountant_month_close'),
    ('20261028090000_daily_tasks_open_all'),
    ('20261028090000_revenue_truth_foundation'),
    ('20261029090000_appointments_foundation')
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261030090000_oauth_identity_foundation'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261030090000_oauth_identity_foundation')
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM ledger WHERE finished_at IS NOT NULL AND migration_name >= '20261030090000_oauth_identity_foundation'),
                      (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND migration_name >= '20261030090000_oauth_identity_foundation')
  UNION ALL SELECT 4, NOT EXISTS (SELECT name FROM expected EXCEPT SELECT migration_name FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
                      (SELECT count(*) FROM (SELECT name FROM expected EXCEPT SELECT migration_name FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) x)
  UNION ALL SELECT 5, NOT EXISTS (SELECT migration_name FROM ledger EXCEPT SELECT name FROM expected),
                      (SELECT count(*) FROM (SELECT migration_name FROM ledger EXCEPT SELECT name FROM expected) x)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_class c JOIN rel_names r ON r.nm = c.relname WHERE c.relnamespace = (SELECT oid FROM pub)),
                      (SELECT count(*) FROM pg_class c JOIN rel_names r ON r.nm = c.relname WHERE c.relnamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pg_proc p JOIN fn_names f ON f.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub)),
                      (SELECT count(*) FROM pg_proc p JOIN fn_names f ON f.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'user\_identity\_%'),
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'user\_identity\_%')
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'id' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'businessId' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'Business' AND attname = 'id' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'password' AND attnotnull)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'emailVerifiedAt'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM (SELECT relowner FROM usr UNION ALL SELECT relowner FROM biz) o WHERE o.relowner = (SELECT oid FROM me)) = 2,
                      (SELECT count(*) FROM (SELECT relowner FROM usr UNION ALL SELECT relowner FROM biz) o WHERE o.relowner = (SELECT oid FROM me))
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM groups WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM groups WHERE rolname = 'app_auth' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid IN (SELECT member FROM members) AND r.oid <> (SELECT oid FROM me)
                                     AND (r.rolsuper OR r.rolbypassrls)),
                       (SELECT count(*) FROM pg_roles r WHERE r.oid IN (SELECT member FROM members) AND r.oid <> (SELECT oid FROM me)
                          AND (r.rolsuper OR r.rolbypassrls))
  UNION ALL SELECT 14, NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'password', 'UPD' || 'ATE')
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'emailVerifiedAt', 'UPD' || 'ATE'), 1
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                                     WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'f'),
                       (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                          WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'f')
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_proc WHERE proname IN ('gen_random_uuid', 'hashtextextended', 'sha256')
                          AND pronamespace = 'pg_catalog'::regnamespace) >= 3,
                       (SELECT count(DISTINCT proname) FROM pg_proc WHERE proname IN ('gen_random_uuid', 'hashtextextended', 'sha256')
                          AND pronamespace = 'pg_catalog'::regnamespace)
  UNION ALL SELECT 17, EXISTS (SELECT 1 FROM me WHERE rolsuper OR rolbypassrls), 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
