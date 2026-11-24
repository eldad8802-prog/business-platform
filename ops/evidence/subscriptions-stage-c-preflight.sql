-- ============================================================================
-- subscriptions-stage-c-preflight.sql — read-only PREFLIGHT before migration
--   20261228090000_subscriptions_stage_c   (NOT applied)
-- Proves Production is the shape the migration expects. Catalog, ledger and counts only — no write, no row content.
-- OUTPUT: n | result | observed_count (the release-migrate gate reads the PASS / FAIL cells).
-- ============================================================================
\echo '== subscriptions stage C preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261228090000_subscriptions_stage_c is NOT recorded'
\echo ' 3 prerequisite 20261224090000_platform_subscriptions is recorded and finished'
\echo ' 4 PlatformSubscription, PlatformSubscriptionEvent, PlatformAuditEvent and User exist'
\echo ' 5 roles app_runtime, app_ctlplane, app_auth and app_admin all exist'
\echo ' 6 none of the eight stage C tables exists yet'
\echo ' 7 none of the fifteen stage C functions exists yet'
\echo ' 8 the migrating role can read across businesses (superuser or BYPASSRLS) — the definer functions rely on it'
\echo ' 9 no PlatformSubscription row is a customer, trialing or limited (stage B state: testers only)'
\echo '10 subscription rows in total (informational)'
\echo '11 businesses in total (informational)'
\echo '12 businesses without a subscription row: computed as testers (informational)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261228090000_subscriptions_stage_c'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261224090000_platform_subscriptions' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
                        AND relname IN ('PlatformSubscription', 'PlatformSubscriptionEvent', 'PlatformAuditEvent', 'User')), 4
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_runtime', 'app_ctlplane', 'app_auth', 'app_admin')), 4
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                        AND relname IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest', 'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent',
                                        'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent', 'PlatformUsageMetricMode')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                        AND proname IN ('subscription_signup_open', 'subscription_expire_due_trials', 'usage_quota_context', 'usage_quota_snapshot',
                                        'usage_consume', 'usage_settle', 'usage_mark_alert', 'subscriptions_require_platform_admin',
                                        'quota_policy_set', 'quota_adjustment_add', 'quota_adjustment_revoke', 'subscription_request_resolve',
                                        'trial_claim_admin_record', 'subscriptions_stage_c_append_only', 'usage_metric_mode_set')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM "PlatformSubscription" WHERE "accountType" = 'CUSTOMER' OR "status" <> 'EXEMPT'), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM "PlatformSubscription"), NULL
  UNION ALL SELECT 11, (SELECT count(*) FROM "Business"), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM "Business" b WHERE NOT EXISTS (SELECT 1 FROM "PlatformSubscription" s WHERE s."businessId" = b."id")), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
