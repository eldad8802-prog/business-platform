-- ============================================================================
-- appointments-open-all-production-evidence.sql
--
-- Read-only Production proof AFTER release-migrate of 20261115100000_appointments_open_all (the calendar, open for
-- every business). Flags and counts only:
--   * the migration is recorded once, finished, with the pinned checksum (LF or CRLF), and nothing is pending;
--   * the appointments definition defaults ON and its policy is global ON, emergency switch OFF;
--   * external booking is exactly as before: OFF by default, OFF globally, no customer link switched on;
--   * no business override was added or changed by it (compare 6–8 with the preflight's 7, 8 and 11).
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== appointments open-all proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 20261115100000_appointments_open_all recorded once, finished, not rolled back, pinned checksum (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 appointments: definition default ON, policy global ON, emergency OFF (flag; expected t)'
\echo ' 5 public_booking: definition default OFF, policy global OFF, emergency OFF (flag; expected t, untouched)'
\echo ' 6 appointments overrides ENABLED (count; expected = preflight 7)'
\echo ' 7 appointments overrides DISABLED (count; expected = preflight 8)'
\echo ' 8 public_booking overrides ENABLED (count; expected = preflight 11)'
\echo ' 9 booking links switched on (count; expected 0)'
\echo '10 booking requests waiting for the owner (count; expected 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pin(lf, crlf) AS (VALUES ('a739b116c5b0b1eca187cfe759eb32c4be1411b3b1203f3a2b9c582c135a02af', 'fe766f5fc078a1e8984d6bd889ea1623f54880a28950a00099d5e1d76fa2bba3')),
st AS (SELECT fd."key", fd."defaultEnabled" AS d, fp."globalEnabled" AS g, fp."emergencyDisabled" AS e
       FROM "PlatformFeatureDefinition" fd JOIN "PlatformFeaturePolicy" fp ON fp."featureKey" = fd."key"
       WHERE fd."key" IN ('appointments', 'public_booking')),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" m, pin WHERE m.migration_name = '20261115100000_appointments_open_all'
                         AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL AND m.checksum IN (pin.lf, pin.crlf)) = 1
                    AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115100000_appointments_open_all') = 1, NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM st WHERE "key" = 'appointments' AND d AND g AND NOT e), NULL
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM st WHERE "key" = 'public_booking' AND NOT d AND NOT g AND NOT e), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'appointments' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'appointments' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'public_booking' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "BookingSettings" WHERE "enabled")
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "BookingRequest" WHERE "status"::text = 'PENDING')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
