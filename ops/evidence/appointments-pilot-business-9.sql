-- ============================================================================
-- appointments-pilot-business-9.sql
--
-- Read-only Production facts for the appointments pilot on the TEST business (businessId = 9), and the
-- proof that no other business is touched. Run before the pilot (readiness), right after the owner
-- switches `appointments` ON for business 9 only, and again after it is switched back.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, amount or text.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== appointments pilot, business 9: legend =='
\echo ' 1 business 9 exists, is not the platform system business, not archived, not in deletion (flag)'
\echo ' 2 users of business 9 (count)'
\echo ' 3 business 9: appointments override is ENABLED (flag)'
\echo ' 4 business 9: appointments override is DISABLED (flag)'
\echo ' 5 business 9: no effective appointments override (no row or INHERIT) (flag)'
\echo ' 6 OTHER businesses with an effective appointments override, ENABLED or DISABLED (count; expected 0)'
\echo ' 7 businesses with any public_booking override row (count; expected 0)'
\echo ' 8 appointments: global policy off and no emergency switch (flag; expected true)'
\echo ' 9 public_booking: global policy off and no emergency switch (flag; expected true)'
\echo '10 business 9: active catalog services (count)'
\echo '11 business 9: active catalog services with a length (count)'
\echo '12 business 9: customers (count)'
\echo '13 business 9: open leads (count)'
\echo '14 business 9: staff members (count)'
\echo '15 business 9: weekly hours windows (count)'
\echo '16 business 9: appointments of any kind (count)'
\echo '17 OTHER businesses: staff members, hours, exceptions, booking rows (count; expected 0)'
\echo '18 OTHER businesses: timed appointments or appointments of a new kind (count; expected 0)'
\echo '19 OTHER businesses: appointment journal rows (count; a baseline — the paths that predate the calendar log too)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
biz AS (
  SELECT b."id" FROM "Business" b
  WHERE b."id" = 9 AND b."name" <> '__PLATFORM_SYSTEM__'
    AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
o9 AS (SELECT a.state::text AS state FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" = 'appointments'),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM biz), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "User" u WHERE u."businessId" = 9)
  UNION ALL SELECT 3, COALESCE((SELECT bool_or(state = 'ENABLED') FROM o9), false), NULL
  UNION ALL SELECT 4, COALESCE((SELECT bool_or(state = 'DISABLED') FROM o9), false), NULL
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM o9 WHERE state IN ('ENABLED', 'DISABLED')), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a
                              WHERE a."featureKey" = 'appointments' AND a."businessId" <> 9 AND a.state::text IN ('ENABLED', 'DISABLED'))
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'public_booking')
  UNION ALL SELECT 8, (SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'appointments'), NULL
  UNION ALL SELECT 9, (SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'public_booking'), NULL
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "BusinessService" s WHERE s."businessId" = 9 AND s."type" = 'SERVICE' AND s."active")
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BusinessService" s WHERE s."businessId" = 9 AND s."type" = 'SERVICE' AND s."active" AND s."durationMinutes" IS NOT NULL)
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "Customer" c WHERE c."businessId" = 9)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "Lead" l WHERE l."businessId" = 9 AND l.status::text IN ('NEW', 'OPEN', 'QUALIFIED', 'QUOTED'))
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "StaffMember" m WHERE m."businessId" = 9)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "AvailabilityRule" r WHERE r."businessId" = 9 AND r."removedAt" IS NULL)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM "Appointment" x WHERE x."businessId" = 9)
  UNION ALL SELECT 17, NULL, (SELECT (SELECT count(*) FROM "StaffMember" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "AvailabilityRule" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "AvailabilityException" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "ServiceBookingPolicy" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "BookingSettings" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "BookingRequest" WHERE "businessId" <> 9))
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM "Appointment" x WHERE x."businessId" <> 9 AND (x."endsAt" IS NOT NULL OR x."kind"::text <> 'CUSTOMER'))
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM "AppointmentEvent" e WHERE e."businessId" <> 9)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
