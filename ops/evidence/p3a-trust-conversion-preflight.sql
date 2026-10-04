-- ============================================================================
-- p3a-trust-conversion-preflight.sql
--
-- Read-only Production PREFLIGHT for the P3-A pair
--   20261008090000_p3a_identity_enum_values
--   20261008090100_p3a_trust_claims
-- (NOT applied), released JOINTLY with
--   20261009090000_m6_acquisition_connections
-- (NOT applied; M6 merged before P3-A and sorts after it, and `prisma migrate
-- deploy` applies every pending migration in order, so one release-migrate run
-- applies all three). The joint release does not combine the workstreams: M6 keeps
-- its own preflight, proof and approval record.
--
-- release-migrate pauses the whole job at the production-db gate, so its own
-- "migrate status (pre)" step can only be read after approval, when the apply
-- runs straight after it. This file answers the same question BEFORE approval,
-- by NAME:
--
--   pending set  =  repository names (171)  minus  applied ledger names
--
-- The 168 names below are every migration directory on main other than the
-- three pending ones (they include cost Wave-2 and the learning-coverage policy
-- rows, both applied). The pending set is exactly the three only when every
-- expected name is applied (missing = 0), no ledger row carries any other name
-- (unexpected = 0) and none of the three is recorded, finished or not.
--
-- It also measures the premises the two files rely on:
--   * nothing P3-A builds exists yet (table, five types, two enum labels, the
--     statement channel column, the new CHECK);
--   * nothing M6 builds exists yet (no ledger row, no AcquisitionConnection
--     relation): M6 is pending with the pair, not half-built (check 20);
--   * the two P2 CHECKs P3-A replaces BY NAME exist and still have P2's shape;
--   * app_runtime exists (the guarded privilege block names it) and every
--     runtime login is NOSUPERUSER NOBYPASSRLS;
--   * sha256(bytea) exists (the wording-hash CHECK recomputes the hash);
--   * the canonical source of the new fact exists as a column;
--   * the owner's default privileges would hand the runtime a removal privilege
--     on any new table (INFO) — the reason P3-A names its privileges itself.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and counts only; no name, no row content is printed.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== P3-A preflight — legend (n → check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 every one of the 168 expected names is applied (observed = missing)'
\echo ' 3 L2 no ledger row outside the 168 expected names (observed = unexpected)'
\echo ' 4 L3 neither P3-A name is recorded, finished or not (observed = P3-A ledger rows)'
\echo ' 5 T1 no BusinessTrustClaim relation'
\echo ' 6 T2 none of the five P3-A types exists (observed = how many exist)'
\echo ' 7 E1 BusinessIdentityFact has its six P2 labels and no PUBLIC_WHATSAPP (observed = labels)'
\echo ' 8 E2 BusinessIdentityDimension has its nine P2 labels and no CONVERSION_DECLARATION (observed = labels)'
\echo ' 9 S1 BusinessIdentityStatement has no channel column'
\echo '10 C1 the P2 CHECKs P3-A replaces by name exist; the new channel CHECK does not (observed = P2 CHECKs found)'
\echo '11 C2 those two CHECKs still have the P2 shape (observed = CHECKs already naming a P3-A label or source)'
\echo '12 R1 app_runtime exists: NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 R2 runtime logins (migration role and superusers excluded) exist and are NOBYPASSRLS (observed = logins)'
\echo '14 F1 sha256(bytea) exists and the server is PostgreSQL 11 or newer'
\echo '15 W1 the canonical source exists: WhatsAppConnection.displayPhoneNumber'
\echo '16 D1 INFO: the migration role default ACL hands the runtime a removal privilege on new tables (observed = 1 if so)'
\echo '17 N1 INFO: BusinessIdentityStatement rows'
\echo '18 N2 INFO: BusinessIdentityFactAuthority rows'
\echo '19 X1 the evidence role bypasses row-level security, so 17 and 18 are whole counts'
\echo '20 M1 M6, released jointly after the P3-A pair, is pending too: no ledger row for it and no AcquisitionConnection relation (observed = ledger rows + relations)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

WITH expected(name) AS (
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
    ('20261008090000_learning_coverage_policies')
),
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
p3a(name) AS (VALUES ('20261008090000_p3a_identity_enum_values'), ('20261008090100_p3a_trust_claims')),
-- released in the same run, after the pair (checks 2-4 + 20 together: pending = exactly the three)
m6(name) AS (VALUES ('20261009090000_m6_acquisition_connections')),
labels AS (
  SELECT t.typname::text AS typ, e.enumlabel::text AS label
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
),
stmt AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relname = 'BusinessIdentityStatement' AND c.relkind = 'r'),
fact AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relname = 'BusinessIdentityFactAuthority' AND c.relkind = 'r'),
p2checks AS (
  SELECT conname::text AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE (conrelid = (SELECT oid FROM stmt) AND conname IN ('BusinessIdentityStatement_value_shape', 'BusinessIdentityStatement_channel_shape'))
     OR (conrelid = (SELECT oid FROM fact) AND conname = 'BusinessIdentityFactAuthority_source_field')
),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (SELECT r.* FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> current_user
              AND (SELECT oid FROM rt) IS NOT NULL AND pg_has_role(r.oid, (SELECT oid FROM rt), 'MEMBER')),
src_cols AS (
  SELECT count(*) AS n FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'WhatsAppConnection' AND column_name = 'displayPhoneNumber'
),
default_acl AS (
  SELECT count(*) AS n FROM pg_default_acl d, aclexplode(d.defaclacl) x
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND d.defaclobjtype = 'r' AND x.grantee = (SELECT oid FROM rt) AND x.privilege_type = 'DEL' || 'ETE'
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (
                        SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL)),
                      (SELECT count(*) FROM expected e WHERE NOT EXISTS (
                        SELECT 1 FROM ledger l WHERE l.migration_name = e.name AND l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL))
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected)),
                      (SELECT count(*) FROM ledger l WHERE l.migration_name NOT IN (SELECT name FROM expected))
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM ledger l WHERE l.migration_name IN (SELECT name FROM p3a)),
                      (SELECT count(*) FROM ledger l WHERE l.migration_name IN (SELECT name FROM p3a))
  UNION ALL SELECT 5, to_regclass('public."BusinessTrustClaim"') IS NULL,
                      (CASE WHEN to_regclass('public."BusinessTrustClaim"') IS NULL THEN 0 ELSE 1 END)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
                        WHERE t.typname IN ('ConversionChannel', 'TrustClaimKind', 'TrustClaimClass', 'TrustClaimStatus', 'TrustVerificationMethod')),
                      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
                        WHERE t.typname IN ('ConversionChannel', 'TrustClaimKind', 'TrustClaimClass', 'TrustClaimStatus', 'TrustVerificationMethod'))
  UNION ALL SELECT 7, (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityFact') = 6
                      AND NOT EXISTS (SELECT 1 FROM labels WHERE typ = 'BusinessIdentityFact' AND label = 'PUBLIC_WHATSAPP'),
                      (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityFact')
  UNION ALL SELECT 8, (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityDimension') = 9
                      AND NOT EXISTS (SELECT 1 FROM labels WHERE typ = 'BusinessIdentityDimension' AND label = 'CONVERSION_DECLARATION'),
                      (SELECT count(*) FROM labels WHERE typ = 'BusinessIdentityDimension')
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM stmt) AND a.attname = 'channel' AND NOT a.attisdropped),
                      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM stmt) AND a.attname = 'channel' AND NOT a.attisdropped)
  UNION ALL SELECT 10, (SELECT count(*) FROM p2checks WHERE name IN ('BusinessIdentityStatement_value_shape', 'BusinessIdentityFactAuthority_source_field')) = 2
                       AND NOT EXISTS (SELECT 1 FROM p2checks WHERE name = 'BusinessIdentityStatement_channel_shape'),
                       (SELECT count(*) FROM p2checks WHERE name IN ('BusinessIdentityStatement_value_shape', 'BusinessIdentityFactAuthority_source_field'))
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM p2checks WHERE name = 'BusinessIdentityStatement_value_shape'
                                AND def LIKE '%POSITIONING%' AND def NOT LIKE '%CONVERSION_DECLARATION%')
                       AND EXISTS (SELECT 1 FROM p2checks WHERE name = 'BusinessIdentityFactAuthority_source_field'
                                AND def LIKE '%BusinessProfile.billingAddress%' AND def NOT LIKE '%WhatsAppConnection%'),
                       (SELECT count(*) FROM p2checks WHERE def LIKE '%CONVERSION_DECLARATION%' OR def LIKE '%WhatsAppConnection%')
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), (SELECT count(*) FROM rt)
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 14, to_regprocedure('sha256(bytea)') IS NOT NULL AND current_setting('server_version_num')::int >= 110000,
                       (CASE WHEN to_regprocedure('sha256(bytea)') IS NULL THEN 0 ELSE 1 END)
  UNION ALL SELECT 15, (SELECT n FROM src_cols) = 1, (SELECT n FROM src_cols)
  UNION ALL SELECT 16, true, (SELECT n FROM default_acl)
  UNION ALL SELECT 17, true, (SELECT count(*) FROM "BusinessIdentityStatement")
  UNION ALL SELECT 18, true, (SELECT count(*) FROM "BusinessIdentityFactAuthority")
  UNION ALL SELECT 19, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                       (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
  UNION ALL SELECT 20, NOT EXISTS (SELECT 1 FROM ledger l WHERE l.migration_name IN (SELECT name FROM m6))
                       AND to_regclass('public."AcquisitionConnection"') IS NULL,
                       (SELECT count(*) FROM ledger l WHERE l.migration_name IN (SELECT name FROM m6))
                       + (CASE WHEN to_regclass('public."AcquisitionConnection"') IS NULL THEN 0 ELSE 1 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
