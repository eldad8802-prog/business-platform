-- ============================================================================
-- service-desk-ui-erasure-text-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261123090000_service_desk_ui_erasure_text   (NOT applied)
--
-- The migration swaps the bodies of three functions of 20261120090000_service_desk_ui_foundation in place (same
-- signatures, same owner, same security properties, same EXECUTE holders): the erasure door
-- service_desk_ui_erase_business() (SECURITY DEFINER) and the two trigger guards service_settings_guard() and
-- service_warranty_offer_guard() (SECURITY INVOKER). Its authority class is privileges + SECURITY DEFINER, so this
-- file pins the security shape the new text inherits.
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; the UI foundation (with the reviewed file's checksum) and
--     the P4 audit journal are recorded and finished;
--   * each of the three functions is exactly the foundation text (md5 of its body), plpgsql, search_path
--     pg_catalog, public, pg_temp; the erasure door is SECURITY DEFINER, VOLATILE, returns integer; the guards are
--     SECURITY INVOKER trigger functions; none of them carries the new text yet;
--   * their owner is the owner of the eight Service UI tables the erasure door touches (the erasure marker accepts
--     only the table owner), and carries BYPASSRLS or is a superuser (the tables force RLS);
--   * EXECUTE: not PUBLIC; app_runtime on the erasure door only, without the right to pass it on; nobody else;
--   * the two guard triggers: BEFORE / FOR EACH ROW / on new, changed and removed rows / enabled;
--   * the helpers the new bodies use (service_ui_in_erasure, service_ui_business_writable) are the foundation text;
--     every column the new bodies name exists (exclusionsText nullable);
--   * app_runtime holds exactly arw on ServiceSettings and ServiceWarrantyOffer (never row removal), nobody else holds
--     anything there; RLS enabled + forced on both;
--   * nothing references ServiceSettings by foreign key (its row can go with the account); it is keyed by businessId;
--     every CHECK on the two tables is validated (the placeholder text fits ServiceWarrantyOffer_texts);
--   * informational: businesses being deleted that still hold a settings row, warranty offers a previous erasure
--     reached whose texts are still there, finished migrations sorting after this one, finished total.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk UI erasure text preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261123090000_service_desk_ui_erasure_text is NOT recorded'
\echo ' 3 20261120090000_service_desk_ui_foundation is recorded, finished, with the reviewed checksum'
\echo ' 4 20261122090000_service_desk_audit_journal is recorded and finished'
\echo ' 5 service_desk_ui_erase_business(): foundation text, plpgsql, SECURITY DEFINER, VOLATILE, integer, search_path ending in pg_temp'
\echo ' 6 service_settings_guard(): foundation text, plpgsql, SECURITY INVOKER, trigger, search_path ending in pg_temp'
\echo ' 7 service_warranty_offer_guard(): foundation text, plpgsql, SECURITY INVOKER, trigger, search_path ending in pg_temp'
\echo ' 8 of the three, already carrying the new text (expected 0)'
\echo ' 9 of the eight Service UI tables, owned by the owner of all three functions (expected 8)'
\echo '10 that owner carries BYPASSRLS or is a superuser'
\echo '11 the erasure door executable by PUBLIC (expected 0)'
\echo '12 app_runtime holds EXECUTE on the erasure door, not passable on'
\echo '13 EXECUTE on the three held by anyone else than the owner and app_runtime on the door (expected 0)'
\echo '14 the two guard triggers: BEFORE, FOR EACH ROW, new + changed + removed rows, enabled (expected 2)'
\echo '15 helpers service_ui_in_erasure(oid) and service_ui_business_writable(integer): foundation text (expected 2)'
\echo '16 columns the new bodies name, present (expected 10; exclusionsText nullable)'
\echo '17 app_runtime holds exactly arw on ServiceSettings and ServiceWarrantyOffer (expected 2)'
\echo '18 any other non-owner role holding anything on those two tables (expected 0)'
\echo '19 RLS enabled and forced on those two tables (expected 2)'
\echo '20 foreign keys referencing ServiceSettings (expected 0)'
\echo '21 ServiceSettings primary key is businessId alone'
\echo '22 CHECK / foreign key constraints on the two tables not validated (expected 0)'
\echo '23 businesses being deleted that still hold a ServiceSettings row (informational)'
\echo '24 warranty offers already erased whose free texts are still there (informational)'
\echo '25 finished migrations sorting after 20261123090000 (informational)'
\echo '26 finished migrations in the ledger (informational)'

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
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261123090000_service_desk_ui_erasure_text'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                          AND checksum = '3a36d70eeec24b5c27ec55d02676a87208a17b5b14eb1bed7ef7c9425a2219d6'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261122090000_service_desk_audit_journal'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM f WHERE f.proname = 'service_desk_ui_erase_business'
                          AND md5(f.prosrc) = '36cc37d04bbaae0aaa0d3956ed451fa0' AND f.prosecdef AND f.provolatile = 'v'
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'integer'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM f WHERE f.proname = 'service_settings_guard'
                          AND md5(f.prosrc) = '2d4070a4f400d57c32f1c97552b09bbd' AND NOT f.prosecdef
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'trigger'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM f WHERE f.proname = 'service_warranty_offer_guard'
                          AND md5(f.prosrc) = '313ad38534b944dd83f7cab617a812bd' AND NOT f.prosecdef
                          AND f.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND f.prorettype = 'trigger'::regtype
                          AND f.cfg = 'search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM f WHERE md5(f.prosrc) IN ('81844110e542afd715a7d93a93be559e', 'a5bb7776cb4ab4d4046f8597a4e1cd60',
                                                                      '7136eb77a7ff62a8b47bae1789f953db')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class k
                        WHERE k.relnamespace = 'public'::regnamespace AND k.relkind = 'r'
                          AND k.relname IN ('ServiceTextVersion', 'ServiceIntakeTermsSnapshot', 'ServiceWarrantyOffer', 'ServiceIntakePhoto',
                                            'ServiceShareEvent', 'ServicePhoneReminder', 'ServiceSettings', 'ServiceStorageErasure')
                          AND (SELECT count(*) FROM f) = 3 AND k.relowner = ALL (SELECT f.proowner FROM f)), 8
  UNION ALL SELECT 10, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner
                         WHERE f.proname = 'service_desk_ui_erase_business' AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE f.proname = 'service_desk_ui_erase_business' AND has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM acl WHERE acl.proname = 'service_desk_ui_erase_business' AND acl.grantee = 'app_runtime'::regrole
                           AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM acl WHERE acl.grantee <> acl.proowner
                           AND NOT (acl.proname = 'service_desk_ui_erase_business' AND acl.grantee = 'app_runtime'::regrole))
                       + (SELECT count(*) FROM f WHERE f.proacl IS NULL), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_trigger g JOIN f ON f.oid = g.tgfoid
                         WHERE (g.tgname, g.tgrelid, f.proname) IN
                               (('ServiceSettings_guard'::name, 'public."ServiceSettings"'::regclass::oid, 'service_settings_guard'::name),
                                ('ServiceWarrantyOffer_guard'::name, 'public."ServiceWarrantyOffer"'::regclass::oid, 'service_warranty_offer_guard'::name))
                           AND g.tgtype = (1 | 2 | 4 | 8 | 16) AND g.tgenabled = 'O' AND g.tgconstraint = 0), 2
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                           AND ((p.proname = 'service_ui_in_erasure' AND p.proargtypes::text = 'oid'::regtype::oid::text
                                 AND md5(p.prosrc) = 'ac2f13ea16d86ad65be7a17ecdcd11d1')
                             OR (p.proname = 'service_ui_business_writable' AND p.proargtypes::text = 'integer'::regtype::oid::text
                                 AND md5(p.prosrc) = 'cff007b74e129067e204d814fff99c48'))), 2
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_attribute a WHERE NOT a.attisdropped AND a.attnum > 0
                           AND ((a.attrelid = 'public."Business"'::regclass AND a.attname IN ('deletionRequestedAt', 'deletedAt'))
                             OR (a.attrelid = 'public."ServiceSettings"'::regclass AND a.attname = 'businessId')
                             OR (a.attrelid = 'public."ServiceWarrantyOffer"'::regclass
                                 AND a.attname IN ('scopeText', 'exclusionsText', 'erasedAt', 'changeReason', 'presentedByUserId',
                                                   'createdByUserId', 'updatedAt')))
                           AND (a.attname <> 'exclusionsText' OR NOT a.attnotnull)), 10
  UNION ALL SELECT 17, (SELECT count(*) FROM t WHERE t.relacl::text LIKE '%app_runtime=arw/%'), 2
  UNION ALL SELECT 18, (SELECT count(*) FROM sec WHERE sec.grantee <> 'app_runtime'::regrole), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM t WHERE t.relrowsecurity AND t.relforcerowsecurity), 2
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_constraint k WHERE k.contype = 'f' AND k.confrelid = 'public."ServiceSettings"'::regclass), 0
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                         WHERE k.conrelid = 'public."ServiceSettings"'::regclass AND k.contype = 'p' AND cardinality(k.conkey) = 1
                           AND a.attname = 'businessId'), 1
  UNION ALL SELECT 22, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype IN ('c', 'f') AND NOT k.convalidated), 0
  UNION ALL SELECT 23, (SELECT count(*) FROM "ServiceSettings" s JOIN "Business" b ON b."id" = s."businessId"
                         WHERE b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL), NULL
  UNION ALL SELECT 24, (SELECT count(*) FROM "ServiceWarrantyOffer" o, sname
                         WHERE o."erasedAt" IS NOT NULL AND (o."scopeText" <> sname.placeholder OR o."exclusionsText" IS NOT NULL)), NULL
  UNION ALL SELECT 25, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261123090000_service_desk_ui_erasure_text' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 26, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
