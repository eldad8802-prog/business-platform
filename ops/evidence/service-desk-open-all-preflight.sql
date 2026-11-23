-- ============================================================================
-- service-desk-open-all-preflight.sql
--
-- Read-only Production preflight BEFORE the Service Desk is opened for every business (release-migrate of
-- 20261221190000_service_desk_open_all, then the application PR that flips the catalog default). Flags and counts only:
--   A.  1-7   the ledger: the migration is not recorded yet, nothing unfinished, every migration on main before it is
--             applied, and 20261222090000 (after it) is not (release-migrate applies a prefix only);
--   B.  8-13  the module's rows: one definition and one policy row, both still OFF, emergency OFF, overrides
--             (business 9 = the pilot; a DISABLED business stays closed after the opening, by design);
--   C. 14-17  who the opening reaches, and the service rows that exist today (all in business 9);
--   D. 18-19  fingerprints of the table privileges and the RLS policies of the service tables (info: the evidence
--             file after the apply must print the same values).
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids except the pilot business.
-- ============================================================================

\echo '== service desk open-all preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; expected t)'
\echo ' 2 20261221190000_service_desk_open_all is not recorded yet (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 20261221090000_business_kind_transition applied (flag; expected t)'
\echo ' 5 20261216090000_activity_packs applied (flag; expected t)'
\echo ' 6 20261120090000_service_desk_ui_foundation applied (flag; expected t, it seeded the two rows)'
\echo ' 7 20261222090000_service_desk_case_records not recorded (flag; expected t, it sorts after ours and stays pending)'
\echo ' 8 service_desk: one definition row and one policy row (flag; expected t)'
\echo ' 9 service_desk: definition default OFF and policy global OFF (flag; expected t, the state the migration expects)'
\echo '10 service_desk: the emergency switch is set (flag; expected f)'
\echo '11 service_desk overrides ENABLED (count; expected 1, business 9)'
\echo '12 service_desk overrides DISABLED (count; expected 0; any such business stays closed)'
\echo '13 business 9: service_desk override is ENABLED (flag; expected t)'
\echo '14 live businesses (not deleted, no deletion requested) (count; every one without a DISABLED override is reached)'
\echo '15 live businesses other than business 9 (count; newly reached)'
\echo '16 service cases outside business 9 (count; expected 0)'
\echo '17 service cases in business 9 (count; info)'
\echo '18 privileges fingerprint of the Service tables (info)'
\echo '19 RLS policies fingerprint of the Service tables (info)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
mig AS (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
d AS (SELECT "defaultEnabled" AS on_ FROM "PlatformFeatureDefinition" WHERE "key" = 'service_desk'),
p AS (SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk'),
live_b AS (SELECT b."id" FROM "Business" b WHERE b."deletedAt" IS NULL AND b."deletionRequestedAt" IS NULL),
svc AS (SELECT c.oid, c.relname, c.relacl FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'Service%'),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261221190000_service_desk_open_all'), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261221090000_business_kind_transition'), NULL
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261216090000_activity_packs'), NULL
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261120090000_service_desk_ui_foundation'), NULL
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261222090000_service_desk_case_records'), NULL
  UNION ALL SELECT 8, (SELECT count(*) FROM d) = 1 AND (SELECT count(*) FROM p) = 1, NULL
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM d WHERE NOT on_) AND EXISTS (SELECT 1 FROM p WHERE NOT g), NULL
  UNION ALL SELECT 10, COALESCE((SELECT bool_or(e) FROM p), false), NULL
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "businessId" = 9 AND "featureKey" = 'service_desk' AND "state"::text = 'ENABLED'), NULL
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM live_b)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM live_b WHERE "id" <> 9)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM "ServiceCase" WHERE "businessId" <> 9)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = 9)
  UNION ALL SELECT 18, NULL, (SELECT ('x' || substr(md5(string_agg(relname || ':' || coalesce(relacl::text, '-'), ',' ORDER BY relname)), 1, 8))::bit(32)::int FROM svc)
  UNION ALL SELECT 19, NULL, (SELECT ('x' || substr(md5(string_agg(pl.polname || ':' || pl.polcmd || ':' || pg_get_expr(pl.polqual, pl.polrelid), ',' ORDER BY pl.polname)), 1, 8))::bit(32)::int
                               FROM pg_policy pl JOIN svc ON svc.oid = pl.polrelid)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
