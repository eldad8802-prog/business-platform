-- ============================================================================
-- m6-acquisition-connections-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261009090000_m6_acquisition_connections   (M6 PR-A — NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean, M6 is not recorded and nothing that sorts after M6 was applied first;
--   * Production AFTER P3-A (owner Option B: P3-A released first as the approved prefix, M6 held, then
--     M6 alone): the P3-A pair (20261008090000_p3a_identity_enum_values, 20261008090100_p3a_trust_claims)
--     is APPLIED (19); BY NAME, every one of the 170 migrations on main other than M6 is finished (20)
--     and the ledger holds nothing else (21) — so M6 is the ONLY pending migration;
--   * what M6's code path writes through exists under ENABLE + FORCE row-level security: Business
--     Intake (IntakeEvent, IntakeNormalizedEvent), identity (IdentityLink, IdentityProposal), the CRM
--     (Customer, Lead, LeadLifecycleEvent) and the feature switches (BusinessFeatureAccess) (22);
--   * P3-A's table exists under FORCE row-level security beside M6's still-absent names (23);
--   * no acquisition data exists: no feature-access row for the three acquisition keys and no intake
--     receipt from the three acquisition sources (24);
--   * none of the names M6 creates exists (table, sequence, indexes, policies, functions) and none
--     of its three feature keys is defined yet;
--   * the FK target Business.id exists; the migration role owns Business and is BYPASSRLS — the
--     pre-tenant lookup functions run as that role and must read the FORCE-RLS table;
--   * app_runtime exists (the privilege blocks run only if it does) and every runtime login is
--     NOSUPERUSER NOBYPASSRLS;
--   * the migration role's DEFAULT privileges hand app_runtime exactly arwd on new tables and rU on
--     new sequences and nobody else anything (M6 revokes d and D itself, ending at arw);
--   * the feature tables accept the ON CONFLICT targets the migration names.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and ledger only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 acquisition connections preflight — legend (n → check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261009090000_m6_acquisition_connections is NOT recorded'
\echo ' 3 L2 every finished migration sorts BEFORE M6 (M6 is next; nothing later was applied first)'
\echo ' 4 L3 finished migrations (INFO count)'
\echo ' 5 N1 none of the relation names M6 creates exists (table, sequence, 5 indexes)'
\echo ' 6 N2 no policy named m6_acquisition_* exists'
\echo ' 7 N3 no function named m6_acquisition_* exists'
\echo ' 8 N4 none of the three acquisition feature keys is defined (definitions + policies)'
\echo ' 9 F1 Business.id is the integer primary key (FK target)'
\echo '10 F2 the migration role owns Business'
\echo '11 F3 the migration role is BYPASSRLS (the SECURITY DEFINER lookups read a FORCE-RLS table)'
\echo '12 R1 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 R2 runtime logins (migration role excluded) are NOSUPERUSER NOBYPASSRLS — observed = how many'
\echo '14 D1 default privileges (migration role, public, tables): app_runtime holds exactly arwd'
\echo '15 D2 default privileges (migration role, public, tables): no other grantee (observed = others)'
\echo '16 D3 default privileges (migration role, public, sequences): app_runtime holds exactly rU'
\echo '17 D4 default privileges (migration role): nothing schema-wide (global) and no other sequence grantee'
\echo '18 P1 PlatformFeatureDefinition.key and PlatformFeaturePolicy.featureKey are unique (ON CONFLICT targets)'
\echo '19 J1 the P3-A pair is APPLIED: two finished rows, none unfinished or rolled back (observed = finished P3-A rows)'
\echo '20 L4 every one of the 170 expected names (all of main except M6) is finished (observed = missing)'
\echo '21 L5 no ledger row outside the 170 expected names: M6 is the only pending migration (observed = unexpected)'
\echo '22 M1 Business Intake, identity, CRM and feature-switch tables M6 writes through exist with RLS ENABLED + FORCED (observed = qualifying, of 8)'
\echo '23 M2 P3-A coexists: BusinessTrustClaim exists with RLS ENABLED + FORCED (observed = 1 if so)'
\echo '24 A1 no acquisition data: feature-access rows for the three keys + intake receipts from the three sources (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel_names(nm) AS (VALUES ('AcquisitionConnection'), ('AcquisitionConnection_id_seq'), ('AcquisitionConnection_pkey'),
  ('AcquisitionConnection_publicId_key'), ('AcquisitionConnection_id_businessId_key'),
  ('AcquisitionConnection_businessId_sourceKey_status_idx'), ('AcquisitionConnection_live_resource_key')),
feature_keys(k) AS (VALUES ('acquisition_meta_lead_ads'), ('acquisition_google_lead_forms'), ('acquisition_web_forms')),
biz AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
me AS (SELECT oid, rolbypassrls FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
              WHERE m.roleid = (SELECT oid FROM rt) AND r.rolcanlogin AND r.rolname <> current_user),
defacl_items AS (
  SELECT d.defaclobjtype AS kind, d.defaclnamespace AS nsp, x.grantee,
         (CASE x.privilege_type
            WHEN 'SELECT' THEN 'r' WHEN 'INS' || 'ERT' THEN 'a' WHEN 'UPD' || 'ATE' THEN 'w'
            WHEN 'DEL' || 'ETE' THEN 'd' WHEN 'TRUNC' || 'ATE' THEN 'D' WHEN 'REFERENCES' THEN 'x'
            WHEN 'TRIGGER' THEN 't' WHEN 'USAGE' THEN 'U' WHEN 'MAINTAIN' THEN 'm' ELSE '?' END) COLLATE "C" AS l
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
  WHERE d.defaclrole = (SELECT oid FROM me)),
defacl AS (SELECT kind, nsp, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM defacl_items GROUP BY kind, nsp, grantee),
uniq_on(tbl, col) AS (VALUES ('PlatformFeatureDefinition', 'key'), ('PlatformFeaturePolicy', 'featureKey')),
p3a_pair(name) AS (VALUES ('20261008090000_p3a_identity_enum_values'), ('20261008090100_p3a_trust_claims')),
p3a_rows AS (SELECT l.migration_name, l.finished_at, l.rolled_back_at FROM ledger l JOIN p3a_pair p ON p.name = l.migration_name),
-- every migration directory on main except M6 (170): applied in Production after P3-A
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
    ('20261008090100_p3a_trust_claims')
),
rls_tables(t) AS (VALUES ('IntakeEvent'), ('IntakeNormalizedEvent'), ('IdentityLink'), ('IdentityProposal'),
  ('Customer'), ('Lead'), ('LeadLifecycleEvent'), ('BusinessFeatureAccess')),
source_keys(k) AS (VALUES ('web.form'), ('google.lead_form'), ('meta.lead_ads')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261009090000_m6_acquisition_connections'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261009090000_m6_acquisition_connections')
  UNION ALL SELECT 3, (SELECT max(migration_name) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
                        < '20261009090000_m6_acquisition_connections', 1
  UNION ALL SELECT 4, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names)),
                      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'm6\_acquisition\_%'),
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'm6\_acquisition\_%')
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'm6\_acquisition\_%'),
                      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'm6\_acquisition\_%')
  UNION ALL SELECT 8, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM feature_keys)) = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM feature_keys))
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                               WHERE k.conrelid = (SELECT oid FROM biz) AND k.contype = 'p' AND cardinality(k.conkey) = 1
                                 AND a.attname = 'id' AND a.atttypid = 'integer'::regtype), 1
  UNION ALL SELECT 10, (SELECT relowner FROM biz) = (SELECT oid FROM me), 1
  UNION ALL SELECT 11, (SELECT rolbypassrls FROM me), 1
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), (SELECT count(*) FROM rt)
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 14, EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'adrw'),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                       (SELECT count(*) FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 17, NOT EXISTS (SELECT 1 FROM defacl WHERE nsp = 0)
                       AND NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE nsp = 0)
  UNION ALL SELECT 18, (SELECT count(*) FROM uniq_on u WHERE EXISTS (
                          SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid AND t.relnamespace = (SELECT oid FROM pub)
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                          WHERE t.relname = u.tbl AND i.indisunique AND i.indnatts = 1 AND a.attname = u.col AND i.indpred IS NULL)) = 2, 2
  UNION ALL SELECT 19, (SELECT count(*) FROM p3a_rows WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 2
                       AND (SELECT count(*) FROM p3a_rows) = 2,
                       (SELECT count(*) FROM p3a_rows WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 20, NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (
                         SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL)),
                       (SELECT count(*) FROM expected e WHERE NOT EXISTS (
                         SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL))
  UNION ALL SELECT 21, NOT EXISTS (SELECT 1 FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected)),
                       (SELECT count(*) FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected))
  UNION ALL SELECT 22, (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                          AND c.relname IN (SELECT t FROM rls_tables) AND c.relrowsecurity AND c.relforcerowsecurity) = 8,
                       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                          AND c.relname IN (SELECT t FROM rls_tables) AND c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL SELECT 23, EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                         AND c.relname = 'BusinessTrustClaim' AND c.relrowsecurity AND c.relforcerowsecurity),
                       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                         AND c.relname = 'BusinessTrustClaim' AND c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL SELECT 24, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM feature_keys))
                       + (SELECT count(*) FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT k FROM source_keys)) = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM feature_keys))
                       + (SELECT count(*) FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT k FROM source_keys))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
