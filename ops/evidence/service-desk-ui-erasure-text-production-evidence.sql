-- ============================================================================
-- service-desk-ui-erasure-text-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261123090000_service_desk_ui_erasure_text was applied.
--
-- The migration swapped the bodies of three functions in place (the erasure door service_desk_ui_erase_business(),
-- SECURITY DEFINER, and the trigger guards service_settings_guard() / service_warranty_offer_guard(), SECURITY
-- INVOKER) and re-stated their EXECUTE holders. No table, column, constraint, policy, table privilege or row changed.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back, with the reviewed file's checksum; the ledger is clean;
--   * each of the three functions is exactly the reviewed text (md5 of its body), plpgsql, search_path pg_catalog,
--     public, pg_temp; the erasure door is SECURITY DEFINER, VOLATILE, returns integer; the guards are SECURITY
--     INVOKER trigger functions;
--   * their owner is still the owner of the eight Service UI tables (the erasure marker accepts only the table owner)
--     and carries BYPASSRLS or is a superuser;
--   * EXECUTE: not PUBLIC; app_runtime on the erasure door only, without the right to pass it on; nobody else;
--   * the two guard triggers still use them (replaced in place: same oid), BEFORE / FOR EACH ROW / on new, changed
--     and removed rows / enabled;
--   * nothing else moved: the helpers service_ui_in_erasure / service_ui_business_writable are the foundation text;
--     app_runtime holds exactly arw on ServiceSettings and ServiceWarrantyOffer (never row removal), nobody else holds
--     anything; RLS enabled + forced on both; no foreign key references ServiceSettings; every CHECK is validated;
--   * informational: businesses being deleted that still hold a settings row (their erasure now takes it), warranty
--     offers a previous erasure reached whose texts are still there (an erasure run completes them).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk UI erasure text evidence: legend (n -> check) =='
\echo ' 1 20261123090000_service_desk_ui_erasure_text is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the ledger checksum is the reviewed migration file'
\echo ' 4 service_desk_ui_erase_business(): the reviewed text (md5 of its body)'
\echo ' 5 service_desk_ui_erase_business(): plpgsql, SECURITY DEFINER, VOLATILE, integer, search_path ending in pg_temp'
\echo ' 6 service_settings_guard(): the reviewed text (md5 of its body)'
\echo ' 7 service_settings_guard(): plpgsql, SECURITY INVOKER, trigger, search_path ending in pg_temp'
\echo ' 8 service_warranty_offer_guard(): the reviewed text (md5 of its body)'
\echo ' 9 service_warranty_offer_guard(): plpgsql, SECURITY INVOKER, trigger, search_path ending in pg_temp'
\echo '10 of the eight Service UI tables, owned by the owner of all three functions (expected 8)'
\echo '11 that owner carries BYPASSRLS or is a superuser'
\echo '12 the erasure door executable by PUBLIC (expected 0)'
\echo '13 app_runtime holds EXECUTE on the erasure door, not passable on'
\echo '14 EXECUTE on the three held by anyone else than the owner and app_runtime on the door (expected 0)'
\echo '15 the two guard triggers on the replaced functions: BEFORE, FOR EACH ROW, new + changed + removed rows, enabled (expected 2)'
\echo '16 helpers service_ui_in_erasure(oid) and service_ui_business_writable(integer): foundation text (expected 2)'
\echo '17 app_runtime holds exactly arw on ServiceSettings and ServiceWarrantyOffer (expected 2)'
\echo '18 any other non-owner role holding anything on those two tables (expected 0)'
\echo '19 RLS enabled and forced on those two tables (expected 2)'
\echo '20 foreign keys referencing ServiceSettings (expected 0)'
\echo '21 CHECK / foreign key constraints on the two tables not validated (expected 0)'
\echo '22 businesses being deleted that still hold a ServiceSettings row (informational)'
\echo '23 warranty offers already erased whose free texts are still there (informational)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosrc, p.prosecdef, p.provolatile, p.prolang, p.prorettype, p.proowner, p.proacl,
         array_to_string(p.proconfig, ',') AS cfg
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.pronargs = 0
     AND p.proname IN ('service_desk_ui_erase_business', 'service_settings_guard', 'service_warranty_offer_guard')
), acl AS (
  SELECT f.proname, f.proowner, x.grantee, x.privilege_type, x.is_grantable FROM f CROSS JOIN LATERAL aclexplode(f.proacl) x
), t AS (
  SELECT k.oid, k.relname, k.relowner, k.relacl, k.relrowsecurity, k.relforcerowsecurity FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace AND k.relkind = 'r'
     AND k.relname IN ('ServiceSettings', 'ServiceWarrantyOffer')
), sec AS (
  SELECT x.grantee FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x WHERE x.grantee <> t.relowner
), sname AS (
  SELECT '[' || chr(1504) || chr(1502) || chr(1495) || chr(1511) || ']' AS placeholder
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261123090000_service_desk_ui_erasure_text'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261123090000_service_desk_ui_erasure_text'
                          AND checksum = 'dc17eb248ec8f6347dfa3e05d3ad8d98f5dc0ede31a83384a993358343f1e562'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM f WHERE f.proname = 'service_desk_ui_erase_business' AND md5(f.prosrc) = '81844110e542afd715a7d93a93be559e'), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM f WHERE f.proname = 'service_desk_ui_erase_business' AND f.prosecdef AND f.provolatile = 'v'
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'integer'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM f WHERE f.proname = 'service_settings_guard' AND md5(f.prosrc) = 'a5bb7776cb4ab4d4046f8597a4e1cd60'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM f WHERE f.proname = 'service_settings_guard' AND NOT f.prosecdef
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'trigger'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM f WHERE f.proname = 'service_warranty_offer_guard' AND md5(f.prosrc) = '7136eb77a7ff62a8b47bae1789f953db'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE f.proname = 'service_warranty_offer_guard' AND NOT f.prosecdef
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'trigger'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class k
                         WHERE k.relnamespace = 'public'::regnamespace AND k.relkind = 'r'
                           AND k.relname IN ('ServiceTextVersion', 'ServiceIntakeTermsSnapshot', 'ServiceWarrantyOffer', 'ServiceIntakePhoto',
                                             'ServiceShareEvent', 'ServicePhoneReminder', 'ServiceSettings', 'ServiceStorageErasure')
                           AND (SELECT count(*) FROM f) = 3 AND k.relowner = ALL (SELECT f.proowner FROM f)), 8
  UNION ALL SELECT 11, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner
                         WHERE f.proname = 'service_desk_ui_erase_business' AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE f.proname = 'service_desk_ui_erase_business' AND has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM acl WHERE acl.proname = 'service_desk_ui_erase_business' AND acl.grantee = 'app_runtime'::regrole
                           AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM acl WHERE acl.grantee <> acl.proowner
                           AND NOT (acl.proname = 'service_desk_ui_erase_business' AND acl.grantee = 'app_runtime'::regrole))
                       + (SELECT count(*) FROM f WHERE f.proacl IS NULL), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_trigger g JOIN f ON f.oid = g.tgfoid
                         WHERE (g.tgname, g.tgrelid, f.proname) IN
                               (('ServiceSettings_guard'::name, 'public."ServiceSettings"'::regclass::oid, 'service_settings_guard'::name),
                                ('ServiceWarrantyOffer_guard'::name, 'public."ServiceWarrantyOffer"'::regclass::oid, 'service_warranty_offer_guard'::name))
                           AND g.tgtype = (1 | 2 | 4 | 8 | 16) AND g.tgenabled = 'O' AND g.tgconstraint = 0), 2
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                           AND ((p.proname = 'service_ui_in_erasure' AND p.proargtypes::text = 'oid'::regtype::oid::text
                                 AND md5(p.prosrc) = 'ac2f13ea16d86ad65be7a17ecdcd11d1')
                             OR (p.proname = 'service_ui_business_writable' AND p.proargtypes::text = 'integer'::regtype::oid::text
                                 AND md5(p.prosrc) = 'cff007b74e129067e204d814fff99c48'))), 2
  UNION ALL SELECT 17, (SELECT count(*) FROM t WHERE t.relacl::text LIKE '%app_runtime=arw/%'), 2
  UNION ALL SELECT 18, (SELECT count(*) FROM sec WHERE sec.grantee <> 'app_runtime'::regrole), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM t WHERE t.relrowsecurity AND t.relforcerowsecurity), 2
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_constraint k WHERE k.contype = 'f' AND k.confrelid = 'public."ServiceSettings"'::regclass), 0
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype IN ('c', 'f') AND NOT k.convalidated), 0
  UNION ALL SELECT 22, (SELECT count(*) FROM "ServiceSettings" s JOIN "Business" b ON b."id" = s."businessId"
                         WHERE b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL), NULL
  UNION ALL SELECT 23, (SELECT count(*) FROM "ServiceWarrantyOffer" o, sname
                         WHERE o."erasedAt" IS NOT NULL AND (o."scopeText" <> sname.placeholder OR o."exclusionsText" IS NOT NULL)), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
