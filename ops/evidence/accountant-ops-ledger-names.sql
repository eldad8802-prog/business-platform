-- ============================================================================
-- accountant-ops-ledger-names.sql
--
-- Read-only Production evidence BEFORE release-migrate of
--   20261107090000_accountant_ops_monitor
--   20261107091000_accountant_delivery_complained
--   20261107092000_accountant_ops_admin_read
--
-- The ledger compared with the repository BY NAME (not by count): the list below is every migration directory on
-- main at 65c41f19 (201 names) with the sha256 of its migration.sql, generated from the git blobs. It proves which
-- migrations Production has NOT run — exactly the three above, by name — that every other one is finished there,
-- and that the ledger holds no name the repository does not.
--
-- OUTPUT: n | flag | observed_count. Names appear only in this legend (fixed text), never as query output.
-- PRIVACY: the ledger only (schema metadata). Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant ops ledger by name: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 repository migrations listed below (count; expected 201)'
\echo ' 3 ledger rows (count)'
\echo ' 4 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 5 ledger names that are NOT a repository migration (count; expected 0)'
\echo ' 6 repository migrations with no finished ledger row (count; expected 3)'
\echo ' 7 20261107090000_accountant_ops_monitor has no ledger row at all (flag; expected t)'
\echo ' 8 20261107091000_accountant_delivery_complained has no ledger row at all (flag; expected t)'
\echo ' 9 20261107092000_accountant_ops_admin_read has no ledger row at all (flag; expected t)'
\echo '10 the not-yet-run set is EXACTLY those three names, nothing else (flag; expected t)'
\echo '11 every other repository migration is finished in the ledger (flag; expected t)'
\echo '12 finished ledger rows whose checksum differs from the repository file (count; informational, expected 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
repo(name, sum) AS (VALUES
  ('20260210120000_billing_invoice_profile_fields', '31dad885b125312a3b7e73e425df97d14e4038cd8a3f3b74861f549593a127f0'),
  ('20260329225659_init', '04671729d25576d30145b8cbfa163a69de8dcb803bf7133fb432a9027307a2a0'),
  ('20260330142739_core_data_layer_v1', '4a0a37abd3270343fb3be821f0f5322ae2a7bcdc3f9e22536fbc8a2096f11516'),
  ('20260404180953_add_message_analysis', '7ba8365efc0e76f3e886b838bd11ffa4518642a42651ae8d29e61cce4bf6f918'),
  ('20260404192959_add_strategy_variant_type', '44c66cb725d660f7cf9449ed5e62cfed17acd57f376adafc3c357afd40f18e65'),
  ('20260408175347_add_user_foundation', '7908a50e9cf3772c9411424e88ab6f6c83e97e7ab018b44c28c399e4abdd8b81'),
  ('20260409200322_add_pricing_engine_models', '972171a1b949e157b5c52a3b6ebd338c83b642a4badc85b5633a3a1b9e6ea515'),
  ('20260409201448_add_pricing_engine_models', '122d743a0403e77ad7e0ed9447f5b8826f2fbdbc55612d936eff004dd13c2eec'),
  ('20260411204133_move_business_fields_to_profile', '3f9068a8f05567d1ccdafb3f295b1a0aa19f1c5ae555ff74c0612e49a491898b'),
  ('20260411231702_business_profile_v1', 'd5af0391f087bdc53aa75c57d0c97d76a4af06e3712dd703eb95235d2180a22b'),
  ('20260413141745_add_deals', '2bced350c1df3d588601fa2ba9a1b51401a4c926cc4f6dd218a12ccbb55a8cbf'),
  ('20260413160913_collaboration_v2_matching_fields', '02f14112f1587bb837f25eca322e86d2530e5ca88c958e830d6f88d4a969d730'),
  ('20260414101056_add_revenue_activation_v1', 'ef22c40c8308065583f3c48bddce82f594318c6875c7243726ea299398d70d53'),
  ('20260415141145_add_redeem_engine_and_fix_relations', '1e7e649fca9009aeadec9e950105f04a5a65c6da514b7cdec658cc5d81a31eba'),
  ('20260416123915_add_content_feedback', '90214e8969e65d46992dcf5645a95e526cc39d6844898c3e2ba79408cdd416ba'),
  ('20260416181707_add_document_engine_v1', '32faaaab184de229fdc82f216b9f5e89fdca8c3bbfca4c499f4c4efd191d8d3c'),
  ('20260416190435_upgrade_vendor_learning_v2', '2f09677ef5ded547fb7abe119ac2dd87d26045695f126dd47dc47f3f91a794e1'),
  ('20260421141909_add_usage_model', 'aab259c9e5bd57ad1c96d8822777d6819e38034f3b82cfbccb8bad80001e49a0'),
  ('20260423112200_add_inventory_intelligence_v1', '695011476a5f9811bee8a436148c48f379de0eac7e54b1c6f88b97d17414bf7f'),
  ('20260423121208_add_inventory_draft_merge_link', '88f7227769096bc08627b7fc8f31432783405a68553c9628d37226f6969b89d9'),
  ('20260423230912_add_inventory_alert_types', '6e545b66587bad3e1888e5db60d1c4565e9e556c31ea3cfa42971ec93109e9a1'),
  ('20260424101150_add_external_sales', '827c96aae77dc4992bfe37882a6fe74b36c3bbad892362786170679a732457ff'),
  ('20260424111131_add_inventory_pending_match_relations', '0e5f95e648fe714276313c19e9b97d76817957141982dc75a736098e8f7842d9'),
  ('20260424135210_add_extraction_fields', 'c675584e40c2a9fd1dbf7973bfd51e02f6701ebd7ea97334a9a5a26526dc135a'),
  ('20260424141045_add_category_suggestion', '946199efa97316026e1a3e7a13da516f870da403478bf3ac7fd0ec59157f7eea'),
  ('20260505101018_add_email_ingestion_models', '292e997c87a875710953f35aec6d5ffdadf174c833f41f5cc75b946246268ce1'),
  ('20260505124400_reconcile_schema_history', '49372a5f2fcc6c9af3fe863874b55edb4e039fd97201a41a04ec1c6a95c7cc0b'),
  ('20260506131728_add_offer_image_url', 'aab94b5d54aa8e680a19478195bd2e9bb625ff8d35a9837fcaf67a410cd62315'),
  ('20260506151600_add_coupon_public_id', 'a553c8d3b25a78f3d6affa78191f0aaa3a598f61a3e556e5a5b4a34a416d5dfb'),
  ('20260507141435_add_billing_module', 'fbd673652bd75fe3464d61e008458296f56c8cebb3648311548c41887a0978ca'),
  ('20260508123333_add_inventory_item_supplier_name', 'b31357ee31345b2772196bf90a1f02decff89d4f473831e1300b7945e7f4f3a9'),
  ('20260510120630_add_financial_event_phase_a', '73611675379e63554075a5d35d828c42b30d9391126a151b2c45790ada4cf5f8'),
  ('20260510140000_billing_business_kind', '753c87dcf9633dacbd77be8bbb6c21438f7891082f7e19cf8265e004a70edbb1'),
  ('20260510180000_billing_pdf_template_style', '1c2990e7dfd72bf815ecee74249675498f90c47118db3a41e39e6b9806b19410'),
  ('20260511123000_add_billing_quote_mvp', 'dc50c3aef64ed5de7e33cad5904ae4770d305a18cde65d511d67111bf181e013'),
  ('20260512120000_add_pos_api_key', '7705431e344346b4cfa313fb4b04b404b2a376392b8f13c882f36b4aacdaf05f'),
  ('20260513120000_add_business_bot_settings', '08436bca597c9276d7b698c75e2b8cf96c7e25a8b76d69ea80eaf3025c17cb94'),
  ('20260513193000_add_show_draft_suggestions_in_inbox', '5febedeb2636be1df610dc275d5d006865c25917c00fc0772c18a5276bd78ebf'),
  ('20260514100000_add_product_link_fields', 'ae522c5753dfca9b7f5dc7a1177e212a0840b1a7c841b3a6ae968c300bf0b532'),
  ('20260514120000_add_content_persistence_models', '36b90095f62f55cd4d78e20e8b68b03d024f8e83c2ae80434de9902084daeacd'),
  ('20260517204000_add_billing_immutable_issued_fields', '053f8297a755dc47b786dd84f2a49a05476f12ad7b05ae7260eedcdeb96832a9'),
  ('20260517223000_add_billing_credit_note_foundation', '93b487a2499f306e518a8b50926ac1970be7b8403173f84fa003f0b9a52c4d2a'),
  ('20260518001000_add_billing_audit_events', '8598f9e890ef70cfe4495f8902469040438999cdc30f48546075927c7f229ec8'),
  ('20260526120000_whatsapp_attachment_import', '07e135370922fc8b42b8bfdd8d8b0ee8027077237c43e20a848bc09fbe3eb8cc'),
  ('20260527120000_platform_admin_foundation', '3c82ce0c034bb276fcd8c4740951385f70b9660069ceac3db150e515e89f2602'),
  ('20260527140000_product_usage_analytics_foundation', '2b9f725fce7bf13b999749a7c2a8a16d2287ae34aab93b43c04d9f15df87e776'),
  ('20260528120000_platform_feature_access_foundation', 'd79c2d9e123453abb1991e769d79880ab8d0fb8be34116ef915e25d483581e70'),
  ('20260528130000_whatsapp_connection_and_customer_phone_unique', 'c50a6a8184c0dca6b79be2c3de2b55bf48cfbaa47db453c309b97108072ffeb3'),
  ('20260531120000_conversation_pending_state', '3f2bcf247a984c9d5d4642ec2a5a42a28a13aa2d5f71c4e4d34b44aadac3a850'),
  ('20260531190000_add_purchase_orders_phase1', 'c4c39f0be9ddc6cd2dd923a3627d02fb5df4b38c9f52cb0fa2667703a39083b9'),
  ('20260531200000_add_receiving_sessions_phase2', 'a239ea7574ef98fc55b7d249e163c639e43f330824a8738558bbdc8dfb61d77e'),
  ('20260531210000_add_purchase_order_remaining_decisions_phase3', '8c6d7c8ea2511d1bfb6825099ce7d63e0ca0ee84b4ee523c064c15a83812fa8f'),
  ('20260601100000_add_cost_layer_basic_phase4', '5ecb12d45e22adfe41afb1c9ea048d367b6c79eceabab0d832bf85403e34a621'),
  ('20260601120000_appointment_object', 'cf68044825833fb367b42a661e10c5eb83a8b6ea7c93b1d73d73224e5347515b'),
  ('20260601200000_add_supplier_foundation_phase5a', '8eaf532510f27c9a4d886e515f8b69e9da65d02d90ef5c288c39940c2136c5bd'),
  ('20260603120000_add_supplier_purchase_draft_line_unit_cost', '39e0a9aea7d9f2a488e6460caa33378e027985b691ea0ea128e72b0bb3d5b838'),
  ('20260608120000_add_customer_billing_tax_identity', 'c8f0a1e4d59b4b71be7d54c7c60f0c86f13170fbe4fbdb45431effd06e108ad5'),
  ('20260609120000_add_business_archive_fields', '0983c0e703523ec29fd58f940a911b0edcfae271aa763eaa365d79e8a56f7f47'),
  ('20260610120000_h1b1_billing_fk_restrict', '70ac4ff5bf1485696a8ba6e4489b3b39361889557755152b22f3c07e6eac1bcb'),
  ('20260610130000_authority_foundation_phase_c', '05667df88ab57126150a4d45c4b6673d59165b75244fb11d625491bcd56a2f7a'),
  ('20260610140000_party_resolution_foundation_t1', 'c21c4bde1cdf788a966c1bbdbccd03eb94b26fa121e4ed349d8b69f7582842b7'),
  ('20260610150000_party_anchor_claim_t2_readiness', '2ecc4cfab021d7d087566d52b5a78c928f4e024765e3423c096512875eedeb60'),
  ('20260611120000_billing_authority_allocation_projection', 'd2ba91cc3e6e31d17dfee156b48c82070718ff454f2078770ae76fcf8e1c139b'),
  ('20260615120000_receipt_payment_doctype_enum', '654b84b05c6622c9264f85141d44fc6eee590f8291d6af8b797c1f894da4bcc4'),
  ('20260615120100_receipt_payment_tables', 'ee2fc657b8ec10cc63052fab99ed0cc551c6f61eb9ab4805e6662e5985530a5e'),
  ('20260618120000_add_correction_ledger', '551312e271c766416b559ee737c594f4326cd622b2afedc3920f3d30fb896a54'),
  ('20260624140000_add_payments_foundation', 'c1b6fdbea490efd3521703a79a864413ce97ebe81a4ae69451597a4da2b3a230'),
  ('20260624150000_add_cardcom_payment_provider', 'c0e8e6d3bc8e2087d8c74a1e251038c368e87f07756ca4ec11a56d611f513f71'),
  ('20260624170000_add_business_bot_profile', '9637d3bb65f7487ecad63eae5e6b2ead51fd5779570ed74091adf0f7a79846b4'),
  ('20260624180000_add_bot_goal_selection', '1691742afe5d9745c308f4e80d845d37b7e05ea8da401dc572f4bb636542ff9c'),
  ('20260624190000_add_bot_setup_and_knowledge', '724bce856040ea496dd233eac522e1eeafb248bdb1945dc763a1af655221ecb2'),
  ('20260625120000_add_activation_and_recommendations', '57bf52c02cd337ed991086871381aae196bd2af914eea7ab9bc04fdb8ccd8cd7'),
  ('20260625130000_add_memory_policy_and_learning', '5910ded2171a7710874d3818ba43f46bcf3347e6681e14a5e27976c308a02c8b'),
  ('20260625140000_add_general_decision_ledger', 'f999b5fce094363b009bffc4f359f919d0670e924d655080b5854da3503c87d9'),
  ('20260625150000_add_ledger_layer_stage', '51eddd19ff7e575c35957e7460b3b6053e28a4e3911dcbc87848e45348128bd1'),
  ('20260629120000_add_documents_search_indexes', '1357f4cdf69067edc128deef1917691e9e4d92e6e4844fc01f93d96ce57adab3'),
  ('20260629130000_add_payment_audit_event', '675aca821fb959c23eb893783417662e97c54e4d71377b68df67005d421e4a9c'),
  ('20260630120000_add_business_obligation_domain', '56640650a32d70e268b170444fa9b1d07cef26535bf3217c8d788c3adeb21663'),
  ('20260705120000_add_paypal_provider', '02ede2a37672cbafbd4ac1e40cc8bbd510fc7e04f7ae95576e13d1dbc1383cc0'),
  ('20260705140000_add_learning_capture_gaps', '3eecb0c99cb0ffc63cd96c4123e5c7679ebb27069a23362fa8f2f2d2bc1eab25'),
  ('20260707120000_add_business_location_hours', 'cdf140b41090651cf2857f419fa0f5fe88914b28898c3ce32258888c93c40240'),
  ('20260715120000_add_crm_notes', '9dccdbea447d9a2720ba58239b99eeee317f5d12be6a066076ae02360a19f372'),
  ('20260716120000_add_authority_submission_held', '0fe41c8540d2044d56abb824719031dc032da4f790d2db73cd0d539661bb05f9'),
  ('20260716120000_add_crm_attachments', 'c1696e07cbdf5f9edeb530bf3d695ba84d76eb91a8115429565257408ee866b6'),
  ('20260721131204_add_supplier_relation_to_purchase_orders', '1d5f21a716445879543b2e139d2ec38033b7d064ff6790bf24e4c6f5fa0f3077'),
  ('20260724120000_add_customer_lifecycle', 'e2d2122bfb9fa2906a1a67851d4b21cbefeeeec1bbd17fba5e53433391582f10'),
  ('20260814120000_add_ria_canonical_referent', '41a4e1dddaf12bb2658612eb701186674a215ee090f25e2158913d3e058135fc'),
  ('20260815120000_add_ria_policy_lineage', 'a0206236dc3e3d69e6ba384564d2b1a28a49f033508150993bf1b964d9a3cb65'),
  ('20260817120000_add_derivation_policy_substrate', '6e555ab655cd8d2942a840a6f45ede4fdfbbfaad52ddf14e8a51c380e80deab5'),
  ('20260817130000_add_billing_signature_data_url', '8e9f97afe532557baa44805a13294591e7c0c9bf71a35abe1389bed21d829048'),
  ('20260818120000_add_derived_claim_substrate', '1c1df88f61c501a283892999e6cd9565bea397aec984c4c59c069612447f5bce'),
  ('20260818130000_bootstrap_vendor_category_policy_v1', 'c137c0c821afa3ebc5781549efbd1e1a29794e2e39d524c99194c792f51cc15b'),
  ('20260818140000_add_signed_pdf_artifact', '5b64fa8ad3abd87784e8687b9b1d63a12f876b2e4d910ae1bfdb3faaf4b3c7c8'),
  ('20260820120000_add_billing_payment_terms_days', 'dab891cda5255f810283222898d8b424f3e3730e2395c19b07be45265091a049'),
  ('20260823120000_add_business_deletion_lifecycle', '1b924c4117fab76c2bc6a78972ead9005ddaec1b249cdd9493f6041df115ef58'),
  ('20260824210000_d2_p7_wave1_tenant_rls', '59daad53b8ae503c031eae335f6f7b77a34c88ffd7c6f119baa28b6d25fb3f00'),
  ('20260825090000_d2_p7_w2gate_admin_read', '0790546ce06e04cded0be1c6decdeaf92e89205ad54234c65fdb6ebc18feca1f'),
  ('20260825120000_d2_p7_wave1_businessprofile_rls', '3d1f81eef97f1e63e80d5faba3f36e0e269cd1f54a768c83d5196b2eba52810d'),
  ('20260825150000_d2_p7_wave2_tenant_rls', 'd0dee8c9fd6dd041cd27ad02744da4670962748eb995f6ceca6d55550794df32'),
  ('20260825200000_d2_p7_wave3_tenant_rls', '84ab6523426a1849d884520c57d7e3375902493d9a31235db99195d80ed30365'),
  ('20260826090000_d2_p7_w4a_message_provider_unique', '089167361fbdfca864b922c733ad306c8ee706b5d45fa6dfdb2e7afc28a91b56'),
  ('20260826120000_documents_dedup_identity', 'f9fe075368db94111fbcd36554a606139d4512c842e6cad8dc84a4bb4a6ca493'),
  ('20260826150000_d2_p7_w4b_whatsapp_tenant_rls', '202895b5693c9b3169b2372346c0af3c443fa0bf43b946fbace6764b6505e884'),
  ('20260826200000_d2_p7_w4c_gmail_tenant_rls', 'c05b7df3e1de2f43b24e1c6ae7b6a63050b8f368536aeae21c4579226448c1b5'),
  ('20260827090000_d2_p7_w4d_documents_tenant_rls', 'fbbfff4724b50cf91da5c00c21b1ad512b05127ae034416275d17499dc08d09c'),
  ('20260830120000_d2_p7_w4ea_payments_tenant_rls', '0313cec03648bb43b51e994d7aae02ef1f002c7fe4be89a2514b9783968d4725'),
  ('20260831090000_leads_w1_core', 'a78ccca866c885d4883168304e5ac33e04c3fb5a0b307c90201f2128c5c272d3'),
  ('20260831120000_d2_p7_w4eb2_billing_tenant_rls', 'ce5f5dd104ffef0e10f2600402295762dc3b3f54f4d6c845ca4768b60c91b794'),
  ('20260831130000_supplier_domain_wiring', 'cea41f44332db027670d92f61ef6a4b57f9cbc3422b863f70ea1ba22e3e0d4a7'),
  ('20260831170000_w25_message_hardening', '6a729cda44702f68df66d971f3875477de0703797d25bd71b73676d5a9ea5fca'),
  ('20260901090000_d2_pw2_business_feature_access_rls', '91d49d8e22d50d4dd6f64a429b3246e09b8cef8cbb01fc23a5b0039a791418ed'),
  ('20260901120000_casa_wave_b_platform_admin_mfa', '8d49cf2926aa2e932408c2b1aaa617a6bfd0cfe12e35314f60ec85b3cc76c2b1'),
  ('20260902090000_d2_ad2a3_conversation_tenant_coherence', '2ea83501d9b7893d06714babb975f41c86ee9c88e92108df8384e6d01189c2ec'),
  ('20260902100000_auth_token_version', '9240e0e46245cac80f5b6b1d2345464e61a7c4086ae11a30b5d351a56f46f9b6'),
  ('20260902120000_d2_cutover2b_pilot_tenant_rls', 'dc64d5b3d405de27b8fe41168f208c950a39380bab7db094a9c89c9768198fa9'),
  ('20260903090000_import_run_execution_ledger', '69e05cd37d85d6e507d5c20cd71206f0060131f5b5c889892b8b3d0ee5c77752'),
  ('20260903200000_notification_persistence', '7204def5eaf4ba75af3c1b099a07b99e849f9c05a0c126b2dba51faea15d661c'),
  ('20260907120000_i8a_historical_fiscal_documents', '843fab5d6b67720ddf2544e8541f5b2996d34d28d48ebdb91aaf20533e8ff114'),
  ('20260908120000_persistent_auth_sessions', '8b4999ebd4d82881b29370cad6369b757ba5c63a3eeee41d2b38c4e8f6428f8f'),
  ('20260908180000_d2_user_business_privilege_narrowing', '3d36b31d47010066748936ae4469061646056c884bd2a2b842f0512edf1e5fb8'),
  ('20260908200000_auth_session_privilege_contract', '6fd6ae29852110da376f64ac035a941b588f5dc0d4549ea5629f14e048c711dd'),
  ('20260909020000_add_payplus_provider', '89ba4a5d9da316cc18c89e874faba6d8510563214fcb4ad0454f4f2831c92033'),
  ('20260913120000_authsession_user_agent', 'eecb0d66334c4fbab47a3ba2d35c96cbbf975d7e1e64023169afe1af21a1deef'),
  ('20260914120000_inbound_email_foundation', 'ef75142dbded2ed86b163f884c32218468fedad168432f229c4c3d84a42463fc'),
  ('20260915090000_f01_import_retry_identity', '1ad7f1b2bf87995803de15636f7bd144becd3287fdd6a2b4ad491f874e8e869c'),
  ('20260915120000_businessprofile_runtime_grants', '797c2e49d9bac1256a175a2a0a2e336ef933875819a7516d4d886e04ce24f162'),
  ('20260915130000_add_sumit_provider', 'f2127dbd286bc93a34c92687f4fc60db576c250b1255bd0d9c63f445589aa85c'),
  ('20260915130100_payment_routing_callback_secret', 'bf353c87d652b63927cbba0644414b061aa81c3110868a638077f5949f0a310a'),
  ('20260916090000_inbound_email_authorized_senders', '42d04292a6071754e2c098ad496ccc24282636b16c7759402c9ce75101b19e7f'),
  ('20260917090000_payables_phase_1a_foundation', '44e433c78225b2f1c22ce95dbccec0d50db9f8aac28fee0a20fd17094500a181'),
  ('20260917090100_payables_phase_1a_tenant_rls', '391afba9712c4c66b8a555f118f1bc2ef4871545b0b35504ee0df8b6fa154cda'),
  ('20260917090200_payables_phase_1a_obligation_backfill', '5d94cb73f87ced0b31e9b84604d63a10db62eb02bfb4ce451cd0d86d7e8f92d0'),
  ('20260917100000_inbound_address_retirement_and_sender_reregistration', 'b0c081f9f70119b2340cf71302727db94ecca2692902aa492a7f3b3abb6c8df3'),
  ('20260918090000_payables_phase_2_document_evidence', '8f0d323b8a2f577ed853b86ed461457288b52a60f94a4f232280073555ef00c6'),
  ('20260918120000_payables_phase_3_cheques_and_bank_accounts', 'bc305e8f4358a7636f77bb79ab149447cb7846666f54b07e5508204cc3f57252'),
  ('20260918140000_inbound_email_challenge_purpose_and_lifecycle', '61cffa5a24fbef58a5f7c9b6fd9c90e908e92271c76dbf27880e2b8f6172f04a'),
  ('20260922090000_c3_payment_accounting_settlement', '286170dad1dcbed2b24eebc066371c009024b9cb668aefbbc091ba6903849775'),
  ('20260922130000_payables_p4_p6_outbound_foundation', 'bc0b64e6ee73226e11b02ba524934ac61af4df7e9ffe49029dcaec78725f7373'),
  ('20260923090000_m0_derived_claim_evidence_link_tenant_fk', 'ae4bc63deec48a90cf18e93bcaa95cc3d6eb87edf385350c632aa92f81977d43'),
  ('20260923100000_m2_knowledge_measure', 'e2e9f7bc00034909c9f4971c33ae121ae6475ad5a018b89d5423bdfa484a56e5'),
  ('20260923110000_m3_business_insight', '3fbb4dadb6c11605407f8e14c863220b8c2d53e69c929305410c0f53092bac43'),
  ('20260924090000_m5_identity_enum_expansion', '30611cb9f3206431c11f192050fb4f7a0540a589258474f45233fa64146a1102'),
  ('20260924090100_m4_m5_knowledge_expansion', '0b3ed41a5ceaa18318c8f7d559b462a6fc06231c35f7ba59ea404467230cb16b'),
  ('20260924180000_m5_collection_action_append_only', '7b4fbfb5d6914d472d968ee09f0fdc0cd542828f2e47d88229a44da3430da65e'),
  ('20260925090000_m55_sensor_fabric', 'd7b8748f4b2fefb553fa34bc3a41e90e874efa4a280d91d7af3084ebdd38d5ff'),
  ('20260926090000_m6_temporal_knowledge', '74f86c70b7763731824a4da4a438d74363995da6d4534855c1982e388de6191f'),
  ('20260926110000_sec_c_tenant_composite_fk', '651d8b8a03ee29aec45da3869fef0fb8e355e69edd7be037ad5e1b2e0f9e6087'),
  ('20260926110100_sec_c_bootstrap_lookup_functions', '51ce4931d14a9dd5734f3bed5372f3622b16b9061e8a485adddb6f2ba1b0e23d'),
  ('20260926110200_sec_c_admin_read_whatsapp_attachment_import', '954bbb48a38618fd69f43ac40c42eba43c577445b704794be043894cf30ce946'),
  ('20260926110300_sec_c_explicit_identity_grants', 'bedafed384925613771fc81b7c4c1af0a9033648cca8265842209287aa12aab2'),
  ('20260926120000_p0_business_evidence', '0986f70c8da0ccafd259a03d886f1335c76ea9b4ebe871224d2573c3daf3b643'),
  ('20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events', 'a0175e7457f18549dd15585756918c0ddf0f954d827c3ce22ced916fd9078b6d'),
  ('20260927090000_payables_installment_workflow', '909c2311e8d7b90ffa11f76ccb54f0fa0450ec8eedb5425d5d648695135d055f'),
  ('20260927120000_p0_asset_provenance_and_source_lines', 'f519fffb9daaa5621bf2716c749ff31643ad24eab5723f2d81ebe0d162b25348'),
  ('20260927180000_m2_intake_event', '01470c1065a5ffa1223064ee1a00af56c4cd9429bf17003e70bb8e70a0d5055e'),
  ('20260928090000_m9_outcome_learning', '483cd2a429fcca777018d875588cb6080ddab6a3096b8ffa4e14a01b81797283'),
  ('20260928120000_p1_business_offering', 'ce64c4cf7db6b8462a5c5c58c697e946892e93812d5bdbae771ff85d392e0703'),
  ('20260929090000_m3_canonical_intake', '67039ce233ce01493107dbd2e19525acce5ca2d4ace2060659c8b694559c3906'),
  ('20260929090000_tenant_rls_closure', 'cd4212eb236d1db948d0f7d88e90816f5ac1d1250aa3c1c831434d7b348e9237'),
  ('20260930090000_knowledge_derive_authority', 'c0377d712c3c001a8c39980fb5b83e4da27bd0c6979eacaa215b516f1429131c'),
  ('20261001090000_m4_identity_routing', 'fe4e9ee4c913b36fdb28e2373a5aeeb27bd9b3a65c5217a29ad111a7c7c3c901'),
  ('20261002090000_crm_lead_lifecycle', '424d29355d8599130ceb772892d246e4289c492484d5f424e203592e387c26fe'),
  ('20261003090000_control_plane_production_privileges', 'ce16662a405871e0d199338eedf4f0c8b3581f5c3f5d018637d5ae73cf0a84ab'),
  ('20261004090000_p2_business_identity', 'ee9b967276290c4ddfe21a97ee886cb4ba173a076adf44187170f9917c569fc6'),
  ('20261005090000_cost_learning_wave1_policies', 'af818827e562b1c3022051d60cdc46484a442326197a3fee6a2f9e11f8447f0a'),
  ('20261006090000_business_tenant_write_rls', 'd507e6efa79ade6efadf4bbcd9a80937385b3a8dfc7102ee9227c611a525595a'),
  ('20261007090000_cost_learning_wave2_patterns', 'f7e9f0e88720a8c84fc63b1e850ecab58904d800572cc0fe5ccde8a4d16f440d'),
  ('20261008090000_learning_coverage_policies', 'fcc9fe3b674adf194a9d41431128b18cb4f587401a6ab17de34c3fd93f1d536f'),
  ('20261008090000_p3a_identity_enum_values', 'c198975e29ccfea5f66f056aaf85983f1ef650fbbf1d7f71ea851178eb58f472'),
  ('20261008090100_p3a_trust_claims', '4394bf1307d588ff43fca5d489488ecf07cc51f842b073181858d8c3fd4677b4'),
  ('20261009090000_m6_acquisition_connections', '9bdbf251828f8c1eafb852481880a6a305e266c52dab86eea19a62d943f766e4'),
  ('20261010090000_business_brain_temporal_policies', '1a0cdec34268b3bbb6dc5a29eb8b5549751a61cf969ad51a5f1cada36fbb24a8'),
  ('20261011090000_onboarding_setup_state', '8e28643bb44e499a28f6f22da1776708cd71170736198ff16997b9186bf31bb7'),
  ('20261011090100_signup_consent_business_rename', '14fbe2a42c4bebee7a45bbf2c35b2ec504dcb78cf597cc80c059799d5d118f0a'),
  ('20261011090200_user_email_casefold_unique', 'd1ecca96200b85e3853cc4b8e32201c7effcb3c4c3b7a0e7c06d0fd8aa172b51'),
  ('20261012090000_closed_loop_recommendation_evidence', 'ea7452bc86d399e5fcde380f62406f30677ec8d4af4b66c8197795381e31f0e3'),
  ('20261013090000_m7a_commerce_telephony_foundation', '3910bdaba780a82e01cec1caf2907ae868244cb29af7e7962a5a654c497a43e5'),
  ('20261013090000_p3e_landing_persistence', 'f3946da065ba29375d7f8820b20820197393ad2552f5f457db6ca90c5944c849'),
  ('20261014090000_m7bc_commerce_demand_and_line_labels', '0ebc9564b455f14f74d28bd3dac4b67179ebf69c59dd9125b4ef8b8a44ce8afd'),
  ('20261015090000_transactional_email_foundation', '386af5d49f6f58034ba7501714d2255429c089261e7e59df3e9c2a758aadf85e'),
  ('20261016090000_payments_core_connection_config', 'd410eb43a4c9852f49cda7edcdc1a7f1b28ec5b609c96a4abade38c6d06d959e'),
  ('20261017090000_auth_email_tokens', '42737f51f551e91ff86670a0be7a482a14a13d516c84c16d573b365ec104b769'),
  ('20261018090000_daily_tasks_foundation', 'ee74fb53f414907a3563122f241e7c1af0de6b2c3d7e70e3215b8783f24ce608'),
  ('20261022090000_task_reminders_push', '49108924b89eb13e7600e5d8bdae1a5135742f76ff8bb2da887bcb3301a7b7ff'),
  ('20261024090000_platform_admin_a1', 'ffb35684c95ca44197a53d648f0d3c3450d4eeb9201fed9818a67eb1e0ad8811'),
  ('20261027090000_accountant_month_close', 'dffae663489f3625f99d58be9c225e7f13f2f5bf5562e03929de8f990582a41a'),
  ('20261028090000_daily_tasks_open_all', '7daefb825a2fd6c04671a4cba799947f64729d441a6337dab1b3f94c4b0ee708'),
  ('20261028090000_revenue_truth_foundation', '7279378d6ee9d244d101dc1a7185546cbce520721b725ccf8197a71fa54de266'),
  ('20261029090000_appointments_foundation', '8950e58a4f4c054f9c603579f1f369daf62f62df282faaf63185883dcc063442'),
  ('20261030090000_oauth_identity_foundation', '28ac0d8e270f1c1d9640d2d20500f5b5cf59d7be8b956b41ae47ebf052cb8bae'),
  ('20261031090000_bank_file_import_feature', '5916696b498f8214c54dd3b55ecfd8b984cca601869b70fceb5a0afa4bfc2bca'),
  ('20261101090000_oauth_ticket_cancel', 'c82c3ecffaa3e419390d1caab1e10ac037335df60a8b7a9925f985495e347614'),
  ('20261102090000_oauth_identity_link', '3ca274fbb5335a5e43d3e37ca662e005b361b03081aa27de52aba20cbad5a962'),
  ('20261103090000_document_supplier_link', '87ce27ed43d323bcf8ca75e98202fb0ccb7098c8131b4704303e2d7d532aeac3'),
  ('20261104090000_pos_rivhit_source', '14b9ec72c2a9ec0d4797af83fb195d187c6ce23a98f6c210335a20497916a394'),
  ('20261105090000_accountant_link_events', '9546eaffe8f443040ac4af947900f6751de19631f3a77f77630dfad2037de619'),
  ('20261106090000_document_supplier_link_open_all', 'c4918da28b650cf61de9a16d9d2c2031b430aebbb3c83209be166f595ac49692'),
  ('20261106090000_public_booking_foundation', 'ed8325b4ed36e36a8be130fec46ac83d2c56a7227ce97e4a8d41863d3f56d879'),
  ('20261107090000_accountant_ops_monitor', '3844018687cc3b7a10e52a1178470b52b052f8fbe4230db793a882a221b94ea7'),
  ('20261107091000_accountant_delivery_complained', '38ecb6c9f10325f9a4de0684e0c26cee5614d1ecc2d693259431a2cc19076846'),
  ('20261107092000_accountant_ops_admin_read', 'c20b1b242dce191541c1a8795787eac1c8dceb6312c9f1f2389bbf96e65eb7a6')),
three(name) AS (VALUES ('20261107090000_accountant_ops_monitor'), ('20261107091000_accountant_delivery_complained'),
                       ('20261107092000_accountant_ops_admin_read')),
led AS (SELECT migration_name AS name, checksum, finished_at IS NOT NULL AND rolled_back_at IS NULL AS ok FROM "_prisma_migrations"),
notrun AS (SELECT r.name FROM repo r WHERE NOT EXISTS (SELECT 1 FROM led l WHERE l.name = r.name AND l.ok)),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM repo)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM led)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM led WHERE NOT ok)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM led l WHERE NOT EXISTS (SELECT 1 FROM repo r WHERE r.name = l.name))
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM notrun)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM led WHERE name = '20261107090000_accountant_ops_monitor'), NULL
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM led WHERE name = '20261107091000_accountant_delivery_complained'), NULL
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM led WHERE name = '20261107092000_accountant_ops_admin_read'), NULL
  UNION ALL SELECT 10, (SELECT count(*) FROM notrun) = 3 AND NOT EXISTS (SELECT 1 FROM notrun WHERE name NOT IN (SELECT name FROM three))
                       AND NOT EXISTS (SELECT 1 FROM three t WHERE t.name NOT IN (SELECT name FROM notrun)), NULL
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM repo r WHERE r.name NOT IN (SELECT name FROM three)
                                     AND NOT EXISTS (SELECT 1 FROM led l WHERE l.name = r.name AND l.ok)), NULL
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM led l JOIN repo r ON r.name = l.name WHERE l.ok AND l.checksum <> r.sum)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
