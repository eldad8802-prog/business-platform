-- ============================================================================
-- accountant-m4m5-preflight.sql
--
-- Read-only Production PREFLIGHT before migrations
--   20261109090000_accountant_delivery_permission   (G5 M4: the per-business send permission flag)
--   20261109091000_accountant_link_otp              (G5 M5: one-time code + device trust for the portal)
--
-- Proves the database is where the two migrations expect it, from the catalog, the ledger and counts only:
--   * the ledger is clean; what they build on is finished (the accountant workflow, its link events, G5 M1);
--   * neither is recorded, and no finished migration sorts after the first of them;
--   * neither new table exists; the flag `accountant_delivery` has no definition, policy or override yet;
--   * the trail's type list is the 2026-11-07 one (27 values, none of the three new ones);
--   * the delivery's (businessId, id) key the new tables reference exists; the trail keeps its RLS and triggers.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant M4 + M5 preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the workflow, link events and the three G5 M1 migrations are finished (observed = of 5)'
\echo ' 4 neither 20261109 migration is recorded yet (observed = rows)'
\echo ' 5 no finished migration sorts after 20261109090000_accountant_delivery_permission (observed = such migrations)'
\echo ' 6 neither AccountantLinkChallenge nor AccountantLinkDevice exists yet (observed = of 2)'
\echo ' 7 the flag accountant_delivery has no definition, policy or business override yet (observed = rows)'
\echo ' 8 AccountantWorkflowEvent_type is validated and lists exactly 27 values (observed = values)'
\echo ' 9 it lists DELIVERY_COMPLAINED and none of LINK_CODE_SENT / LINK_CODE_FAILED / LINK_DEVICE_VERIFIED (observed = new values listed)'
\echo '10 the key AccountantDelivery(businessId, id) the new tables reference exists (observed = such unique indexes)'
\echo '11 the trail keeps RLS ENABLED + FORCED and both append-only triggers (observed = triggers of 2)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
before(name) AS (VALUES ('20261027090000_accountant_month_close'), ('20261105090000_accountant_link_events'),
                        ('20261107090000_accountant_ops_monitor'), ('20261107091000_accountant_delivery_complained'),
                        ('20261107092000_accountant_ops_admin_read')),
mine(name) AS (VALUES ('20261109090000_accountant_delivery_permission'), ('20261109091000_accountant_link_otp')),
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                         AND migration_name IN (SELECT name FROM before)) = 5,
                      (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                         AND migration_name IN (SELECT name FROM before))
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mine)) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mine))
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261109090000_accountant_delivery_permission') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261109090000_accountant_delivery_permission')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                         AND relname IN ('AccountantLinkChallenge', 'AccountantLinkDevice')) = 0,
                      (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                         AND relname IN ('AccountantLinkChallenge', 'AccountantLinkDevice'))
  UNION ALL SELECT 7, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery')
                    + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery')
                    + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery') = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery')
                    + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery')
                    + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery')
  UNION ALL SELECT 8, coalesce((SELECT convalidated AND (array_length(regexp_split_to_array(def, '::text'), 1) - 1) = 27 FROM con), false),
                      coalesce((SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) FROM con), 0)
  UNION ALL SELECT 9, coalesce((SELECT def LIKE '%''DELIVERY_COMPLAINED''%' AND def NOT LIKE '%''LINK_CODE_SENT''%'
                                       AND def NOT LIKE '%''LINK_CODE_FAILED''%' AND def NOT LIKE '%''LINK_DEVICE_VERIFIED''%' FROM con), false),
                      coalesce((SELECT (CASE WHEN def LIKE '%''LINK_CODE_SENT''%' THEN 1 ELSE 0 END) + (CASE WHEN def LIKE '%''LINK_CODE_FAILED''%' THEN 1 ELSE 0 END)
                                     + (CASE WHEN def LIKE '%''LINK_DEVICE_VERIFIED''%' THEN 1 ELSE 0 END) FROM con), 0)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname = 'AccountantDelivery_businessId_id_key' AND i.indisunique) = 1,
                       (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname = 'AccountantDelivery_businessId_id_key' AND i.indisunique)
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity)
                       AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                              AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                          AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
