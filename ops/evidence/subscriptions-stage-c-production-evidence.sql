-- ============================================================================
-- subscriptions-stage-c-production-evidence.sql — read-only EVIDENCE after migration
--   20261228090000_subscriptions_stage_c
-- Proves the release did exactly what the migration says and nothing else: seven tables, FORCE RLS on the five tenant
-- tables, exact privileges, the definer functions and who may execute them, the owner's opening quota matrix, and NO
-- change to any business's subscription (the testers stay testers). Catalog, ledger and counts only — no row content.
-- Re-runnable later as the shadow monitor (rows 21-26).
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== subscriptions stage C evidence: legend (n -> check) =='
\echo ' 1 20261228090000_subscriptions_stage_c recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the seven stage C tables exist'
\echo ' 4 RLS enabled and forced on the five tenant tables'
\echo ' 5 no FOR ALL policy on any stage C table'
\echo ' 6 app_runtime may write none of: trial claims, quota policy and history, adjustments, counters, usage events'
\echo ' 7 app_runtime may file requests (INSERT) on its own business only: exactly one runtime INSERT policy, keyed on the business'
\echo ' 8 no runtime policy on the trial claims (the runtime sees zero rows)'
\echo ' 9 app_admin holds SELECT only (no INSERT / UPDATE / DELETE) on the nine subscription tables'
\echo '10 app_admin read policies (p7adm_read) on the seven tenant tables'
\echo '11 the fourteen functions exist, all SECURITY DEFINER with a pinned search_path except the trigger function'
\echo '12 PUBLIC may execute none of them'
\echo '13 usage_consume / usage_settle / usage_mark_alert / usage_quota_snapshot / subscription_expire_due_trials: app_runtime only'
\echo '14 subscription_signup_open: app_auth only'
\echo '15 the five admin writers and usage_quota_context: app_admin only (no runtime, no auth)'
\echo '16 the append-only triggers exist and are enabled (policy history, trial claims)'
\echo '17 the opening matrix: 40 policy rows (8 metrics x 5 tiers), each with one opening history row'
\echo '18 the opening matrix values match the owner decision of 2026-11-24 (rows that differ)'
\echo '19 no PlatformSubscription row was written by the migration (every row still a BACKFILL / ADMIN row, none SIGNUP)'
\echo '20 no row is trialing (trials are OFF until a separate owner decision)'
\echo '21 trial claims (informational; 0 until trials are switched on)'
\echo '22 open subscription requests (informational)'
\echo '23 active quota adjustments (informational)'
\echo '24 usage counters (informational; shadow measurement)'
\echo '25 usage units recorded OVER_SHADOW (informational: a customer would have been refused)'
\echo '26 usage units left RESERVED for more than an hour (informational; reconciliation backlog)'
WITH tbl AS (
  SELECT c.oid, c.relname FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
     AND c.relname IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest', 'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent',
                       'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent')
),
tenant AS (SELECT * FROM tbl WHERE relname IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest', 'BusinessQuotaAdjustment',
                                                'BusinessUsageCounter', 'BusinessUsageEvent')),
fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('subscription_signup_open', 'subscription_expire_due_trials', 'usage_quota_context', 'usage_quota_snapshot',
                       'usage_consume', 'usage_settle', 'usage_mark_alert', 'subscriptions_require_platform_admin', 'quota_policy_set',
                       'quota_adjustment_add', 'quota_adjustment_revoke', 'subscription_request_resolve', 'trial_claim_admin_record',
                       'subscriptions_stage_c_append_only')
),
x AS (SELECT f.proname, r.rolname, has_function_privilege(r.oid, f.oid, 'EXECUTE') AS can
        FROM fn f CROSS JOIN pg_roles r WHERE r.rolname IN ('app_runtime', 'app_auth', 'app_admin', 'app_ctlplane')),
want(metric, tier, quota) AS (VALUES
  ('business_documents', 'TRIAL', 50), ('business_documents', 'BASIC', 200), ('business_documents', 'ADVANCED', 600), ('business_documents', 'PREMIUM', 2000), ('business_documents', 'FREE_LIMITED', 0),
  ('document_uploads', 'TRIAL', 100), ('document_uploads', 'BASIC', 200), ('document_uploads', 'ADVANCED', 600), ('document_uploads', 'PREMIUM', 2000), ('document_uploads', 'FREE_LIMITED', 0),
  ('ocr_pages', 'TRIAL', 150), ('ocr_pages', 'BASIC', 300), ('ocr_pages', 'ADVANCED', 1000), ('ocr_pages', 'PREMIUM', 3000), ('ocr_pages', 'FREE_LIMITED', 0),
  ('storage_customer_bytes', 'TRIAL', 1073741824), ('storage_customer_bytes', 'BASIC', 5368709120), ('storage_customer_bytes', 'ADVANCED', 21474836480),
  ('storage_customer_bytes', 'PREMIUM', 53687091200), ('storage_customer_bytes', 'FREE_LIMITED', 1073741824),
  ('accountant_packages', 'TRIAL', 2), ('accountant_packages', 'BASIC', 3), ('accountant_packages', 'ADVANCED', 6), ('accountant_packages', 'PREMIUM', 12), ('accountant_packages', 'FREE_LIMITED', 1),
  ('accountant_emails', 'TRIAL', 3), ('accountant_emails', 'BASIC', 5), ('accountant_emails', 'ADVANCED', 20), ('accountant_emails', 'PREMIUM', 50), ('accountant_emails', 'FREE_LIMITED', 0),
  ('ai_owner_actions', 'TRIAL', 0), ('ai_owner_actions', 'BASIC', 0), ('ai_owner_actions', 'ADVANCED', 0), ('ai_owner_actions', 'PREMIUM', 300), ('ai_owner_actions', 'FREE_LIMITED', 0),
  ('video_renders', 'TRIAL', 0), ('video_renders', 'BASIC', 0), ('video_renders', 'ADVANCED', 0), ('video_renders', 'PREMIUM', 0), ('video_renders', 'FREE_LIMITED', 0)),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261228090000_subscriptions_stage_c' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM tbl), 7
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE oid IN (SELECT oid FROM tenant) AND relrowsecurity AND relforcerowsecurity), 5
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (SELECT relname FROM tbl) AND cmd = 'ALL'), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM tbl t CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(priv)
                         WHERE t.relname <> 'PlatformSubscriptionRequest' AND has_table_privilege('app_runtime', t.oid, v.priv)), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PlatformSubscriptionRequest' AND cmd = 'INSERT'
                         AND 'app_runtime' = ANY (roles) AND with_check LIKE '%app.current_business_id%'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PlatformTrialClaim'
                         AND ('app_runtime' = ANY (roles) OR 'public' = ANY (roles))), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class t CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(priv)
                         WHERE t.relnamespace = 'public'::regnamespace AND t.relkind = 'r'
                           AND t.relname IN ('PlatformSubscription', 'PlatformSubscriptionEvent', 'PlatformTrialClaim', 'PlatformSubscriptionRequest',
                                             'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent', 'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent')
                           AND has_table_privilege('app_admin', t.oid, v.priv)), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'p7adm_read' AND cmd = 'SELECT'
                          AND tablename IN ('PlatformSubscription', 'PlatformSubscriptionEvent', 'PlatformTrialClaim', 'PlatformSubscriptionRequest',
                                            'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent')), 7
  UNION ALL SELECT 11, (SELECT count(*) FROM fn WHERE (proname = 'subscriptions_stage_c_append_only' AND NOT prosecdef)
                          OR (proname <> 'subscriptions_stage_c_append_only' AND prosecdef AND array_to_string(proconfig, ',') LIKE 'search_path=%')), 14
  UNION ALL SELECT 12, (SELECT count(*) FROM fn WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM x WHERE proname IN ('usage_consume', 'usage_settle', 'usage_mark_alert', 'usage_quota_snapshot', 'subscription_expire_due_trials')
                          AND can <> (rolname = 'app_runtime')), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM x WHERE proname = 'subscription_signup_open' AND can <> (rolname = 'app_auth')), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM x WHERE proname IN ('quota_policy_set', 'quota_adjustment_add', 'quota_adjustment_revoke',
                                                                  'subscription_request_resolve', 'trial_claim_admin_record', 'usage_quota_context')
                          AND can <> (rolname = 'app_admin')), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('PlatformQuotaPolicyEvent_append_only', 'PlatformTrialClaim_append_only')
                          AND NOT tgisinternal AND tgenabled = 'O'), 2
  UNION ALL SELECT 17, (SELECT count(*) FROM "PlatformQuotaPolicy" p WHERE EXISTS (SELECT 1 FROM "PlatformQuotaPolicyEvent" e
                          WHERE e."metric" = p."metric" AND e."tier" = p."tier" AND e."fromQuota" IS NULL AND e."actorUserId" IS NULL)), 40
  UNION ALL SELECT 18, (SELECT count(*) FROM want w FULL JOIN "PlatformQuotaPolicy" p ON p."metric" = w.metric AND p."tier" = w.tier
                          WHERE p."quota" IS DISTINCT FROM w.quota::bigint), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM "PlatformSubscription" WHERE "source" = 'SIGNUP'), 0
  UNION ALL SELECT 20, (SELECT count(*) FROM "PlatformSubscription" WHERE "status" = 'TRIALING'), 0
  UNION ALL SELECT 21, (SELECT count(*) FROM "PlatformTrialClaim"), NULL
  UNION ALL SELECT 22, (SELECT count(*) FROM "PlatformSubscriptionRequest" WHERE "status" = 'OPEN'), NULL
  UNION ALL SELECT 23, (SELECT count(*) FROM "BusinessQuotaAdjustment" WHERE "revokedAt" IS NULL), NULL
  UNION ALL SELECT 24, (SELECT count(*) FROM "BusinessUsageCounter"), NULL
  UNION ALL SELECT 25, (SELECT count(*) FROM "BusinessUsageEvent" WHERE "verdict" = 'OVER_SHADOW'), NULL
  UNION ALL SELECT 26, (SELECT count(*) FROM "BusinessUsageEvent" WHERE "state" = 'RESERVED' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '1 hour'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
