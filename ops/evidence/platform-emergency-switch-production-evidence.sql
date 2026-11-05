-- ============================================================================
-- platform-emergency-switch-production-evidence.sql
--
-- Read-only Production PROOF after release-migrate applied 20261113090000_platform_feature_emergency_switch.
-- The migration only adds one SECURITY DEFINER function and EXECUTE on it for app_ctlplane; this proves exactly that.
--
--   1 E1 the ledger holds the migration, finished, not rolled back, with the pinned checksum (observed = such rows)
--   2 E2 the function exists once, with the expected arguments (observed = matching functions)
--   3 E3 it is SECURITY DEFINER and VOLATILE (observed = 1 when so)
--   4 E4 it pins search_path = pg_catalog, public, pg_temp and lock_timeout = 5s (observed = 1 when so)
--   5 E5 EXECUTE: app_ctlplane yes; app_runtime, app_auth, app_admin and PUBLIC no (observed = 1 when so)
--   6 E6 it is owned by the owner of PlatformFeaturePolicy (observed = 1 when so)
--   7 E7 its body holds the fixed allowlist, the FG advisory key, the audit row and no globalEnabled write (observed = 1 when so)
--   8 E8 still no runtime / control plane role holds a direct write on PlatformFeaturePolicy (observed = such privileges)
--   9 E9 the emergency switch is still OFF for the seven intake sources — the migration touched no state (observed = rows on)
--  10 E10 the evidence role bypasses row-level security, so every count is whole
--
-- OUTPUT: n | result | observed_count. PRIVACY: catalog facts and counts only.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
fkeys(k) AS (VALUES ('acquisition_web_forms'), ('acquisition_google_lead_forms'), ('acquisition_meta_lead_ads'),
                    ('commerce_woocommerce'), ('commerce_wix'), ('telephony_cloudtalk'), ('telephony_voicenter')),
fn AS (SELECT p.oid, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl,
              pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'platform_set_feature_emergency'),
-- Direct grants of a / w / d / D (the ACL letters of the four write privileges) to those roles on the table.
writers AS (SELECT r.rolname FROM pg_roles r, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'PlatformFeaturePolicy'
               AND r.rolname IN ('app_runtime', 'app_ctlplane', 'app_auth', 'app_admin')
               AND coalesce(c.relacl::text, '') ~ ('(^|[{,])"?' || r.rolname || '"?=[A-Za-z*]*[awdD]')),
exec_ok AS (SELECT 1 FROM fn WHERE fn.proacl IS NOT NULL
              AND has_function_privilege('app_ctlplane', fn.oid, 'EXECUTE')
              AND NOT has_function_privilege('app_runtime', fn.oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('app_auth', 'app_admin') AND has_function_privilege(r.oid, fn.oid, 'EXECUTE'))
              AND NOT EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0)),
body_ok AS (SELECT 1 FROM fn WHERE fn.def LIKE '%pg_advisory_xact_lock(17991, hashtext(p_feature_key))%'
              AND fn.def LIKE '%''acquisition_web_forms'', ''acquisition_google_lead_forms'', ''acquisition_meta_lead_ads''%'
              AND fn.def LIKE '%''commerce_woocommerce'', ''commerce_wix'', ''telephony_cloudtalk'', ''telephony_voicenter''%'
              AND fn.def LIKE '%PlatformAuditEvent%' AND fn.def LIKE '%PLATFORM_FEATURE_EMERGENCY_SET%'
              AND fn.def NOT LIKE '%"globalEnabled"%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_platform_feature_emergency_switch'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND checksum = '82363679151ec8fb5004ff9f347a359f7f69f0a3f1737c1d3c856866adb55975') = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_platform_feature_emergency_switch'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND checksum = '82363679151ec8fb5004ff9f347a359f7f69f0a3f1737c1d3c856866adb55975')
  UNION ALL SELECT 2, (SELECT count(*) FROM fn WHERE fn.args = 'p_feature_key text, p_on boolean, p_actor_user_id integer, p_reason text, p_ip text, p_user_agent text') = 1
                        AND (SELECT count(*) FROM fn) = 1,
                      (SELECT count(*) FROM fn WHERE fn.args = 'p_feature_key text, p_on boolean, p_actor_user_id integer, p_reason text, p_ip text, p_user_agent text')
  UNION ALL SELECT 3, (SELECT count(*) FROM fn WHERE fn.prosecdef AND fn.provolatile = 'v') = 1, (SELECT count(*) FROM fn WHERE fn.prosecdef AND fn.provolatile = 'v')
  UNION ALL SELECT 4, (SELECT count(*) FROM fn WHERE fn.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp', 'lock_timeout=5s']) = 1,
                      (SELECT count(*) FROM fn WHERE fn.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp', 'lock_timeout=5s'])
  UNION ALL SELECT 5, (SELECT count(*) FROM exec_ok) = 1, (SELECT count(*) FROM exec_ok)
  UNION ALL SELECT 6, (SELECT count(*) FROM fn WHERE fn.proowner = (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                                  WHERE n.nspname = 'public' AND c.relname = 'PlatformFeaturePolicy')) = 1,
                      (SELECT count(*) FROM fn WHERE fn.proowner = (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                                  WHERE n.nspname = 'public' AND c.relname = 'PlatformFeaturePolicy'))
  UNION ALL SELECT 7, (SELECT count(*) FROM body_ok) = 1, (SELECT count(*) FROM body_ok)
  UNION ALL SELECT 8, (SELECT count(*) FROM writers) = 0, (SELECT count(*) FROM writers)
  UNION ALL SELECT 9, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys) AND "emergencyDisabled") = 0,
                      (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys) AND "emergencyDisabled")
  UNION ALL SELECT 10, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                       (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
