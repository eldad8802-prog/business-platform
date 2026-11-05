-- ============================================================================
-- platform-emergency-switch-preflight.sql
--
-- Read-only Production PREFLIGHT for migration 20261114090000_platform_feature_emergency_switch (Leads L1.5-a).
--
--   1 P1 the migration is not in the ledger yet (observed = ledger rows for it)
--   2 P2 no migration in the ledger is unfinished or rolled back (observed = such rows)
--   3 P3 the switch function is not there yet (observed = functions named platform_set_feature_emergency) [fails after]
--   4 P4 the seven intake source features have their policy row (observed = rows)
--   5 P5 the emergency switch is OFF for all seven (observed = rows with it on)
--   6 P6 the control plane role app_ctlplane exists (observed = roles)
--   7 P7 no runtime / control plane role holds a direct write on PlatformFeaturePolicy (observed = such privileges)
--   8 P8 the evidence role bypasses row-level security, so every count is whole
--
-- OUTPUT: n | result | observed_count. PRIVACY: catalog facts and counts only.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
fkeys(k) AS (VALUES ('acquisition_web_forms'), ('acquisition_google_lead_forms'), ('acquisition_meta_lead_ads'),
                    ('commerce_woocommerce'), ('commerce_wix'), ('telephony_cloudtalk'), ('telephony_voicenter')),
fn AS (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'platform_set_feature_emergency'),
pol AS (SELECT p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" IN (SELECT k FROM fkeys)),
-- Direct grants of a / w / d / D (the ACL letters of the four write privileges) to those roles on the table.
writers AS (SELECT r.rolname FROM pg_roles r, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'PlatformFeaturePolicy'
               AND r.rolname IN ('app_runtime', 'app_ctlplane', 'app_auth', 'app_admin')
               AND coalesce(c.relacl::text, '') ~ ('(^|[{,])"?' || r.rolname || '"?=[A-Za-z*]*[awdD]')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_platform_feature_emergency_switch') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_platform_feature_emergency_switch')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM fn) = 0, (SELECT count(*) FROM fn)
  UNION ALL SELECT 4, (SELECT count(*) FROM pol) = 7, (SELECT count(*) FROM pol)
  UNION ALL SELECT 5, (SELECT count(*) FROM pol WHERE "emergencyDisabled") = 0, (SELECT count(*) FROM pol WHERE "emergencyDisabled")
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_ctlplane') = 1, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_ctlplane')
  UNION ALL SELECT 7, (SELECT count(*) FROM writers) = 0, (SELECT count(*) FROM writers)
  UNION ALL SELECT 8, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                      (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
