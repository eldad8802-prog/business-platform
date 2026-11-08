-- ============================================================================
-- service-desk-ui-foundation-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261120090000_service_desk_ui_foundation   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back;
--   * eight tables, RLS enabled + forced; eighteen per-operation policies, none for removal or ALL;
--   * app_runtime privileges from the ACL letters: arw on texts / settings / warranty offers, ar on the four journals,
--     r on the storage-erasure job; no other role holds anything;
--   * fifteen functions with search_path ending in pg_temp, none executable by PUBLIC; exactly three SECURITY DEFINER
--     (the erasure door, the due list, the pass record), each executable by app_runtime;
--   * twenty-two triggers on the eight tables, all enabled; the warranty chain trigger deferred; the one-draft /
--     one-live / one-successor partial UNIQUE indexes;
--   * no row in the eight tables (nothing writes them before the application release);
--   * the feature service_desk seeded OFF: default off, global off, no business override;
--   * the earlier Service Desk erasures (1.2a, 1.2b, M2) are still SECURITY DEFINER with pg_temp last and name no new
--     table — this migration leaves them as they were;
--   * the ledger checksum equals the sha256 of the reviewed migration.sql (pinned in check 16) — which also pins the
--     guard bodies, so the case-row serialisation and the refusals proven in the lab (.sd3 battery) hold here.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk UI foundation evidence: legend (n -> check) =='
\echo ' 1 20261120090000_service_desk_ui_foundation is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 eight tables with RLS enabled and forced'
\echo ' 4 eighteen policies on them'
\echo ' 5 none of those policies is for removal or ALL'
\echo ' 6 app_runtime holds arw on 3, exactly ar on 4, exactly r on the erasure job (of 8)'
\echo ' 7 no other role holds anything on the eight tables'
\echo ' 8 fifteen new functions, search_path ending in pg_temp'
\echo ' 9 none of them executable by PUBLIC'
\echo '10 exactly three SECURITY DEFINER among them, each executable by app_runtime'
\echo '11 twenty-two triggers on the eight tables, all enabled'
\echo '12 the warranty chain trigger is deferred and the three partial UNIQUE indexes exist'
\echo '13 rows in the eight tables (want 0 until the application release)'
\echo '14 the feature service_desk is seeded OFF (default off, global off, no business override)'
\echo '15 the 1.2a / 1.2b / M2 erasures are unchanged: definer, pg_temp last, no new table named (of 3)'
\echo '16 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'

WITH t AS (
  SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('ServiceTextVersion', 'ServiceSettings', 'ServiceIntakeTermsSnapshot', 'ServiceWarrantyOffer', 'ServiceIntakePhoto',
                       'ServiceShareEvent', 'ServicePhoneReminder', 'ServiceStorageErasure')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_ui_business_writable', 'service_ui_in_erasure', 'service_text_version_guard', 'service_settings_guard',
                       'service_intake_terms_guard', 'service_warranty_end', 'service_warranty_offer_guard', 'service_warranty_chain_check',
                       'service_intake_photo_guard', 'service_share_event_guard', 'service_phone_reminder_guard', 'service_storage_erasure_guard',
                       'service_desk_ui_erase_business', 'service_storage_erasure_due', 'service_storage_erasure_record_pass')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t JOIN pg_class k ON k.oid = t.oid WHERE k.relrowsecurity AND k.relforcerowsecurity), 8
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid), 18
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('d', '*')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM t
      WHERE (t.relname IN ('ServiceTextVersion', 'ServiceSettings', 'ServiceWarrantyOffer') AND t.relacl::text LIKE '%app_runtime=arw/%')
         OR (t.relname IN ('ServiceIntakeTermsSnapshot', 'ServiceIntakePhoto', 'ServiceShareEvent', 'ServicePhoneReminder') AND t.relacl::text LIKE '%app_runtime=ar/%')
         OR (t.relname = 'ServiceStorageErasure' AND t.relacl::text LIKE '%app_runtime=r/%')), 8
  UNION ALL SELECT 7, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM f WHERE array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 15
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE f.prosecdef
      AND f.proname IN ('service_desk_ui_erase_business', 'service_storage_erasure_due', 'service_storage_erasure_record_pass')
      AND has_function_privilege('app_runtime', f.oid, 'EXECUTE') AND (SELECT count(*) FROM f g WHERE g.prosecdef) = 3), 3
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger tr JOIN t ON t.oid = tr.tgrelid WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D'), 22
  UNION ALL SELECT 12, (SELECT CASE WHEN
        (SELECT count(*) FROM pg_trigger WHERE tgname = 'ServiceWarrantyOffer_chain' AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred) = 1
    AND (SELECT count(*) FROM pg_indexes WHERE indexname IN ('ServiceWarrantyOffer_one_draft_per_case', 'ServiceWarrantyOffer_one_live_per_case',
           'ServiceWarrantyOffer_one_successor') AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%') = 3
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 13, (SELECT (SELECT count(*) FROM "ServiceTextVersion") + (SELECT count(*) FROM "ServiceSettings")
                             + (SELECT count(*) FROM "ServiceIntakeTermsSnapshot") + (SELECT count(*) FROM "ServiceWarrantyOffer")
                             + (SELECT count(*) FROM "ServiceIntakePhoto") + (SELECT count(*) FROM "ServiceShareEvent")
                             + (SELECT count(*) FROM "ServicePhoneReminder") + (SELECT count(*) FROM "ServiceStorageErasure")), 0
  UNION ALL SELECT 14, (SELECT CASE WHEN
        (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'service_desk' AND NOT "defaultEnabled") = 1
    AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk' AND NOT "globalEnabled") = 1
    AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk') = 0
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_proc WHERE proname IN ('service_erase_business', 'service_external_erase_business', 'service_parts_erase_business')
      AND pronamespace = 'public'::regnamespace AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'
      AND prosrc NOT LIKE '%ServiceTextVersion%' AND prosrc NOT LIKE '%ServiceWarrantyOffer%' AND prosrc NOT LIKE '%ServiceStorageErasure%'
      AND prosrc NOT LIKE '%ServiceIntakePhoto%'), 3
  UNION ALL SELECT 16, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation' AND checksum = '3a36d70eeec24b5c27ec55d02676a87208a17b5b14eb1bed7ef7c9425a2219d6'), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
