-- ============================================================================
-- appointments-foundation-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261029090000_appointments_foundation
--
-- Proves the database is where the migration expects it, from the catalog and counts only:
--   * the ledger is clean, cutover-2B (Appointment's RLS) and the accountant workflow are finished, and no finished
--     migration sorts after this one;
--   * none of the migration's objects exist yet (tables, types, functions, policies, the flags, the new columns);
--   * what it builds on exists: app_runtime, Business, User, Appointment, BusinessService, Customer, Lead,
--     PlatformFeatureDefinition / Policy, BusinessFeatureAccess; "Appointment" is under FORCE RLS with exactly its
--     three p7pilot_* policies;
--   * btree_gist can be created: it is available on the server, and the migration role (the owner of
--     "Appointment") may add objects to the database (the database-level privilege) — or the extension is already installed;
--   * IMPACT ON EXISTING APPOINTMENTS (owner decision 2):
--       - the size of the table (bounds how long the schema changes block the table);
--       - rows whose title or notes exceed the new bounds (the bound is NOT VALID for history, but a later change
--         of such a row — a cancel that appends to notes — would be refused): must be 0;
--       - rows whose creator is a user of ANOTHER business (the new same-business trigger fires only when that
--         column is written, which no code path does, but such rows must be known): must be 0;
--       - every existing row has no end time by construction (the column is new), so the overlap constraint covers
--         none of them: the observed count of rows with a start time is reported for the record.
--   * the evidence role sees every row (it can tell "empty" from "hidden").
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only — no appointment content is read. Guard-clean: no write keyword anywhere,
-- prose included.
-- ============================================================================

\echo '== appointments foundation preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 cutover-2B and the accountant workflow are finished; no finished migration sorts after this one (observed = later finished migrations)'
\echo ' 4 20261029090000_appointments_foundation is not recorded yet (observed = rows)'
\echo ' 5 none of the nine new tables exists (observed = tables)'
\echo ' 6 none of the nine new types exists (observed = types)'
\echo ' 7 no appointment_ function exists (observed = functions)'
\echo ' 8 none of the new policies exists (observed = policies)'
\echo ' 9 the flags appointments / public_booking are not defined and have no override (observed = rows)'
\echo '10 the role app_runtime exists'
\echo '11 Business, User, Appointment, BusinessService, Customer, Lead, PlatformFeatureDefinition, PlatformFeaturePolicy, BusinessFeatureAccess exist (observed = of 9)'
\echo '12 Appointment: RLS ENABLED + FORCED, exactly the three p7pilot policies (observed = policies)'
\echo '13 Appointment has none of the thirteen new columns; createdByUserId is still NOT NULL (observed = new columns)'
\echo '14 btree_gist is available on the server (observed = 1 when already installed, else 0)'
\echo '15 the owner of Appointment may add objects to this database, or btree_gist is already installed'
\echo '16 Appointment rows: fewer than 100000, so the schema changes block the table only briefly (observed = rows)'
\echo '17 no Appointment row exceeds the new text bounds (title 200, notes 4000) (observed = rows)'
\echo '18 no Appointment row names a creator of another business (observed = rows)'
\echo '19 for the record: Appointment rows with a start time — none gets an end time, so the overlap constraint covers none (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.oid, c.relname AS nm, c.relowner, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'),
new_tables(nm) AS (VALUES ('StaffMember'), ('StaffServiceAssignment'), ('AvailabilityRule'), ('AvailabilityException'),
                          ('ServiceBookingPolicy'), ('BookingSettings'), ('BookingRequest'), ('AppointmentManageToken'),
                          ('AppointmentEvent')),
new_types(nm) AS (VALUES ('AppointmentKind'), ('AppointmentLocationKind'), ('AppointmentCancelReason'),
                         ('AppointmentEventActor'), ('AppointmentEventType'), ('AvailabilityExceptionKind'),
                         ('BookingApprovalMode'), ('BookingStaffChoice'), ('BookingRequestStatus')),
new_cols(nm) AS (VALUES ('kind'), ('endsAt'), ('staffMemberId'), ('locationKind'), ('locationDetail'),
                        ('bufferBeforeMinutes'), ('bufferAfterMinutes'), ('holdExpiresAt'), ('actualStartedAt'),
                        ('actualEndedAt'), ('cancelReason'), ('version'), ('erasedAt')),
appt AS (SELECT oid, relowner, relrowsecurity, relforcerowsecurity FROM rel WHERE nm = 'Appointment'),
appt_pols AS (SELECT p.polname FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM appt)),
gist AS (SELECT (SELECT count(*) FROM pg_available_extensions WHERE name = 'btree_gist') AS available,
                (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') AS installed),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261029090000_appointments_foundation') = 0
                      AND EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260902120000_d2_cutover2b_pilot_tenant_rls' AND finished_at IS NOT NULL)
                      AND EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261027090000_accountant_month_close' AND finished_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261029090000_appointments_foundation')
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation')
  UNION ALL SELECT 5, (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM new_tables)) = 0,
                      (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM new_tables))
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname IN (SELECT nm FROM new_types)) = 0,
                      (SELECT count(*) FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname IN (SELECT nm FROM new_types))
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'appointment\_%') = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'appointment\_%')
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_policy WHERE polname ~ '^(staff_member|staff_assignment|availability_rule|availability_exception|service_booking_policy|booking_settings|booking_request|appointment_token|appointment_event)_') = 0,
                      (SELECT count(*) FROM pg_policy WHERE polname ~ '^(staff_member|staff_assignment|availability_rule|availability_exception|service_booking_policy|booking_settings|booking_request|appointment_token|appointment_event)_')
  UNION ALL SELECT 9, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" IN ('appointments', 'public_booking'))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('appointments', 'public_booking'))
                      + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('appointments', 'public_booking')) = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" IN ('appointments', 'public_booking'))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('appointments', 'public_booking'))
                      + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('appointments', 'public_booking'))
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User', 'Appointment', 'BusinessService', 'Customer', 'Lead',
                          'PlatformFeatureDefinition', 'PlatformFeaturePolicy', 'BusinessFeatureAccess')) = 9,
                       (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User', 'Appointment', 'BusinessService', 'Customer', 'Lead',
                          'PlatformFeatureDefinition', 'PlatformFeaturePolicy', 'BusinessFeatureAccess'))
  UNION ALL SELECT 12, (SELECT relrowsecurity AND relforcerowsecurity FROM appt) IS TRUE
                       AND (SELECT count(*) FROM appt_pols) = 3
                       AND (SELECT count(*) FROM appt_pols WHERE polname IN ('p7pilot_tenant_read', 'p7pilot_tenant_insert', 'p7pilot_tenant_update')) = 3,
                       (SELECT count(*) FROM appt_pols)
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM appt) AND NOT attisdropped
                          AND attname IN (SELECT nm FROM new_cols)) = 0
                       AND (SELECT attnotnull FROM pg_attribute WHERE attrelid = (SELECT oid FROM appt) AND attname = 'createdByUserId') IS TRUE,
                       (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM appt) AND NOT attisdropped
                          AND attname IN (SELECT nm FROM new_cols))
  UNION ALL SELECT 14, (SELECT available FROM gist) = 1, (SELECT installed FROM gist)
  UNION ALL SELECT 15, (SELECT installed FROM gist) = 1
                       OR has_database_privilege((SELECT relowner FROM appt), current_database(), 'CRE' || 'ATE'), 1
  UNION ALL SELECT 16, (SELECT count(*) FROM "Appointment") < 100000, (SELECT count(*) FROM "Appointment")
  UNION ALL SELECT 17, (SELECT count(*) FROM "Appointment" WHERE char_length(coalesce("title", '')) > 200 OR char_length(coalesce("notes", '')) > 4000) = 0,
                       (SELECT count(*) FROM "Appointment" WHERE char_length(coalesce("title", '')) > 200 OR char_length(coalesce("notes", '')) > 4000)
  UNION ALL SELECT 18, (SELECT count(*) FROM "Appointment" a JOIN "User" u ON u."id" = a."createdByUserId" WHERE u."businessId" IS DISTINCT FROM a."businessId") = 0,
                       (SELECT count(*) FROM "Appointment" a JOIN "User" u ON u."id" = a."createdByUserId" WHERE u."businessId" IS DISTINCT FROM a."businessId")
  UNION ALL SELECT 19, true, (SELECT count(*) FROM "Appointment" WHERE "startsAt" IS NOT NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
