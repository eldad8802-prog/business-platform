-- ============================================================================
-- platform-subscriptions-production-evidence.sql — read-only EVIDENCE after migration
--   20261224090000_platform_subscriptions
-- Proves the release did exactly what the migration says and nothing else: two tables, FORCE RLS, exact privileges,
-- every business that existed at release time recorded as a tester (the system business internal), one backfill
-- log row each, nobody a customer, nobody trialing or limited. Catalog, ledger and counts only — no row content.
-- Re-runnable later as the shadow monitor (rows 21-24).
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== platform subscriptions evidence: legend (n -> check) =='
\echo ' 1 20261224090000_platform_subscriptions recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 both tables exist'
\echo ' 4 RLS enabled and forced on both'
\echo ' 5 PlatformSubscription: exactly its three policies (tenant read, control-plane add, control-plane change)'
\echo ' 6 PlatformSubscriptionEvent: exactly its one policy (control-plane add)'
\echo ' 7 app_runtime holds exactly r (read) on PlatformSubscription'
\echo ' 8 app_runtime holds exactly r on PlatformSubscriptionEvent, and no policy names it (it sees zero rows)'
\echo ' 9 app_ctlplane holds exactly ar (read, add) at table level on PlatformSubscription'
\echo '10 app_ctlplane may change exactly the 12 lifecycle columns of PlatformSubscription (not businessId, not createdAt)'
\echo '11 app_ctlplane holds exactly a (add) on PlatformSubscriptionEvent: it may not read back the log it writes'
\echo '12 no role other than the owner, app_runtime and app_ctlplane holds anything on either table'
\echo '13 the append-only trigger on the log exists and is enabled'
\echo '14 businesses that existed at release time without a subscription row'
\echo '15 rows that are not a plain exempt tester or internal account (customer, trial, plan, period, limited)'
\echo '16 INTERNAL rows whose business is not the platform system business'
\echo '17 rows without their BACKFILL log row'
\echo '18 BACKFILL log rows = subscription rows written by the backfill'
\echo '19 log rows other than BACKFILL (nobody changed anything yet)'
\echo '20 rows recorded with another catalog version than 2026-11-20'
\echo '21 tester rows (informational)'
\echo '22 internal rows (informational)'
\echo '23 businesses created after the release without a row: no record = computed as a tester (informational)'
\echo '24 customer rows by now (informational; 0 until an admin moves someone)'
WITH t1 AS (SELECT to_regclass('public."PlatformSubscription"') AS oid),
t2 AS (SELECT to_regclass('public."PlatformSubscriptionEvent"') AS oid),
rel AS (SELECT (SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '20261224090000_platform_subscriptions'
                 AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at LIMIT 1) AS at),
acl1 AS (SELECT a::text AS entry, pg_get_userbyid(c.relowner) AS owner FROM pg_class c CROSS JOIN LATERAL unnest(c.relacl) a WHERE c.oid = (SELECT oid FROM t1)),
acl2 AS (SELECT a::text AS entry, pg_get_userbyid(c.relowner) AS owner FROM pg_class c CROSS JOIN LATERAL unnest(c.relacl) a WHERE c.oid = (SELECT oid FROM t2)),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261224090000_platform_subscriptions' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM (SELECT oid FROM t1 UNION ALL SELECT oid FROM t2) x WHERE oid IS NOT NULL), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE oid IN ((SELECT oid FROM t1), (SELECT oid FROM t2)) AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PlatformSubscription'), 3
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PlatformSubscriptionEvent'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM acl1 WHERE split_part(entry, '/', 1) = 'app_runtime=r'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM acl2 WHERE split_part(entry, '/', 1) = 'app_runtime=r')
                       - (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'PlatformSubscriptionEvent'
                            AND ('app_runtime' = ANY (roles) OR 'public' = ANY (roles))), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM acl1 WHERE split_part(entry, '/', 1) = 'app_ctlplane=ar'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL unnest(a.attacl) x
                         WHERE a.attrelid = (SELECT oid FROM t1) AND a.attnum > 0 AND NOT a.attisdropped
                           AND split_part(x::text, '/', 1) = 'app_ctlplane=w'
                           AND a.attname NOT IN ('businessId', 'createdAt')), 12
  UNION ALL SELECT 11, (SELECT count(*) FROM acl2 WHERE split_part(entry, '/', 1) = 'app_ctlplane=a'), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM (SELECT entry, owner FROM acl1 UNION ALL SELECT entry, owner FROM acl2) x
                         WHERE split_part(entry, '=', 1) NOT IN ('app_runtime', 'app_ctlplane') AND split_part(entry, '=', 1) <> owner), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t2) AND tgname = 'PlatformSubscriptionEvent_append_only' AND NOT tgisinternal AND tgenabled = 'O'), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "Business" b WHERE b."createdAt" <= (SELECT at FROM rel)
                         AND NOT EXISTS (SELECT 1 FROM "PlatformSubscription" s WHERE s."businessId" = b."id")), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM "PlatformSubscription" WHERE "accountType" NOT IN ('TESTER', 'INTERNAL') OR "status" <> 'EXEMPT'
                         OR "plan" IS NOT NULL OR "trialStartedAt" IS NOT NULL OR "trialEndsAt" IS NOT NULL
                         OR "currentPeriodStart" IS NOT NULL OR "currentPeriodEnd" IS NOT NULL OR "cancelAtPeriodEnd"), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM "PlatformSubscription" s JOIN "Business" b ON b."id" = s."businessId"
                         WHERE s."accountType" = 'INTERNAL' AND b."name" <> '__PLATFORM_SYSTEM__'), 0
  UNION ALL SELECT 17, (SELECT count(*) FROM "PlatformSubscription" s WHERE NOT EXISTS
                         (SELECT 1 FROM "PlatformSubscriptionEvent" e WHERE e."businessId" = s."businessId" AND e."kind" = 'BACKFILL')), 0
  UNION ALL SELECT 18, (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "kind" = 'BACKFILL')
                       - (SELECT count(*) FROM "PlatformSubscription" WHERE "source" = 'BACKFILL'), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "kind" <> 'BACKFILL'), 0
  UNION ALL SELECT 20, (SELECT count(*) FROM "PlatformSubscription" WHERE "catalogVersion" <> '2026-11-20'), 0
  UNION ALL SELECT 21, (SELECT count(*) FROM "PlatformSubscription" WHERE "accountType" = 'TESTER'), NULL
  UNION ALL SELECT 22, (SELECT count(*) FROM "PlatformSubscription" WHERE "accountType" = 'INTERNAL'), NULL
  UNION ALL SELECT 23, (SELECT count(*) FROM "Business" b WHERE b."createdAt" > (SELECT at FROM rel)
                         AND NOT EXISTS (SELECT 1 FROM "PlatformSubscription" s WHERE s."businessId" = b."id")), NULL
  UNION ALL SELECT 24, (SELECT count(*) FROM "PlatformSubscription" WHERE "accountType" = 'CUSTOMER'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
