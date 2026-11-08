-- ============================================================================
-- appointments-open-all-preflight.sql
--
-- Read-only Production preflight BEFORE release-migrate of 20261121090000_appointments_open_all (the calendar, open
-- for every business). Flags and counts only:
--   * the migration is not recorded yet and the ledger is clean;
--   * the two rows it switches exist once each and are still OFF, emergency switch OFF;
--   * which businesses already carry a decision of their own: ENABLED overrides (the pilot, business 9) and DISABLED
--     overrides — a DISABLED business stays closed after the opening, by design; the owner sees the count first;
--   * external booking is OFF globally and no customer link is switched on — the opening leaves it as it is;
--   * how many businesses the opening reaches.
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids except the pilot business.
-- ============================================================================

\echo '== appointments open-all preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 20261121090000_appointments_open_all is not recorded yet (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 appointments: one definition row and one policy row (flag; expected t)'
\echo ' 5 appointments: definition default OFF and policy global OFF (flag; expected t, the state the migration expects)'
\echo ' 6 appointments: the platform emergency switch is set (flag; expected f)'
\echo ' 7 appointments overrides ENABLED (count; info, business 9 = the pilot)'
\echo ' 8 appointments overrides DISABLED (count; expected 0; any such business stays closed after the opening)'
\echo ' 9 business 9: appointments override is ENABLED (flag; expected t)'
\echo '10 external booking (public_booking): definition default OFF, policy global OFF, emergency OFF (flag; expected t)'
\echo '11 public_booking overrides ENABLED (count; info, business 9 kept its pilot row)'
\echo '12 booking links switched on (count; expected 0)'
\echo '13 businesses in total (count; info, every one without a DISABLED override gets the calendar)'
\echo '14 businesses that already hold appointments (count; info)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
d AS (SELECT "defaultEnabled" AS on_ FROM "PlatformFeatureDefinition" WHERE "key" = 'appointments'),
p AS (SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'appointments'),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261121090000_appointments_open_all'), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM d) = 1 AND (SELECT count(*) FROM p) = 1, NULL
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM d WHERE NOT on_) AND EXISTS (SELECT 1 FROM p WHERE NOT g), NULL
  UNION ALL SELECT 6, COALESCE((SELECT bool_or(e) FROM p), false), NULL
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'appointments' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'appointments' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "businessId" = 9 AND "featureKey" = 'appointments' AND "state"::text = 'ENABLED'), NULL
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" fd JOIN "PlatformFeaturePolicy" fp ON fp."featureKey" = fd."key"
                                WHERE fd."key" = 'public_booking' AND NOT fd."defaultEnabled" AND NOT fp."globalEnabled" AND NOT fp."emergencyDisabled"), NULL
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'public_booking' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "BookingSettings" WHERE "enabled")
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "Business")
  UNION ALL SELECT 14, NULL, (SELECT count(DISTINCT "businessId") FROM "Appointment")
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
