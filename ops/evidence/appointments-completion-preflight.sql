-- ============================================================================
-- appointments-completion-preflight.sql
--
-- Read-only Production preflight BEFORE release-migrate of 20261230090000_appointments_completion (series, journal
-- labels, booking settings, phone verification, customer WhatsApp deliveries). Catalog, ledger and counts only:
--   * the migration is not recorded yet, the ledger is clean, and the migrations it builds on are recorded
--     (appointments foundation, public booking foundation, notification engine foundation, the newest on main);
--   * none of its objects exists yet (tables, columns, labels, functions) — the migration refuses a second run;
--   * its premises hold: app_runtime exists and is still a plain NOLOGIN role; the "Customer" and "Appointment"
--     tenant keys exist; the same-business trigger function exists; "NotificationDelivery" is under FORCED RLS;
--     the journal's append-only triggers are in place;
--   * the defaults it changes for NEW rows are still MANUAL / false today; how many rows it meets (counts only).
--
-- OUTPUT: n | PASS/FAIL | observed (info lines: PASS always, the count is for the owner). An \echo legend.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids, no phone numbers.
-- ============================================================================

\echo '== appointments completion preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (info; t expected)'
\echo ' 2 20261230090000_appointments_completion is not recorded yet (observed = rows, want 0)'
\echo ' 3 ledger rows unfinished or rolled back (want 0)'
\echo ' 4 the migrations it builds on are recorded and finished (observed = of 4)'
\echo ' 5 AppointmentSeries and BookingPhoneChallenge are still absent (observed = found, want 0)'
\echo ' 6 none of the 16 new columns exists yet (observed = found, want 0)'
\echo ' 7 AppointmentEventType holds exactly its 7 original labels (observed = labels)'
\echo ' 8 NotificationChannel holds exactly IN_APP, PUSH (observed = labels)'
\echo ' 9 AppointmentSeriesFrequency does not exist yet (want 0)'
\echo '10 the five new functions and the two guard functions are still absent (want 0)'
\echo '11 app_runtime exists: NOLOGIN NOSUPERUSER NOBYPASSRLS (want 1)'
\echo '12 premise keys: Customer (businessId, id) + Appointment (id, businessId) + appointment_user_same_business() (observed = of 3)'
\echo '13 NotificationDelivery: RLS enabled and forced (want 1)'
\echo '14 AppointmentEvent: both journal-guard triggers exist (observed = of 2)'
\echo '15 BookingSettings defaults are still MANUAL and false (observed = of 2)'
\echo '16 BookingSettings rows (info: they keep their values)'
\echo '17 NotificationDelivery rows (info: each becomes a USER delivery, nothing else changes)'
\echo '18 Appointment rows (info: none joins a series)'
\echo '19 public_booking: OFF globally (want 0 policies globally ON)'
\echo '20 BookingSettings rows with requireVerification = false (info: compare with proof line 26 — the release keeps them)'
\echo '21 BookingSettings rows with defaultApprovalMode = MANUAL (info: compare with proof line 27)'
\echo '22 ledger rows that sort AFTER 20261230090000_appointments_completion (want 0: the name must sort after every migration at release)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH c(n, observed, want, info) AS (
            SELECT 1, (SELECT count(*) FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)), 1::bigint, true
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261230090000_appointments_completion'), 0, false
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0, false
  UNION ALL SELECT 4, (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      AND migration_name IN ('20261029090000_appointments_foundation', '20261106090000_public_booking_foundation',
                             '20261210090000_notification_engine_foundation', '20261225090000_kind_transition_issuer_declaration_wiring')), 4, false
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('AppointmentSeries', 'BookingPhoneChallenge')), 0, false
  UNION ALL SELECT 6, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
         (table_name = 'Appointment' AND column_name IN ('seriesId', 'seriesIndex'))
      OR (table_name = 'BookingSettings' AND column_name IN ('selfRescheduleEnabled', 'selfRescheduleWindowHours', 'reminderOffsetsMinutes', 'bookingHorizonDays', 'showLogo'))
      OR (table_name = 'BookingRequest' AND column_name = 'phoneVerifiedAt')
      OR (table_name = 'NotificationDelivery' AND column_name IN ('recipientKind', 'recipientPhone', 'templateKey', 'messageClass', 'providerMessageId',
                                                                  'providerStatus', 'providerUpdatedAt', 'appointmentId')))), 0, false
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AppointmentEventType'), 7, false
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationChannel'), 2, false
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_type WHERE typname = 'AppointmentSeriesFrequency'), 0, false
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('notification_whatsapp_due', 'notification_delivery_by_provider_message', 'booking_otp_send_counts',
                         'booking_phone_challenge_purge', 'notification_customer_phone_purge', 'booking_phone_challenge_guard',
                         'notification_customer_delivery_guard')), 0, false
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1, false
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint WHERE conname = 'Customer_businessId_id_key')
      + (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'Appointment_id_businessId_key' AND relkind = 'i')
      + (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'appointment_user_same_business'), 3, false
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'NotificationDelivery' AND relrowsecurity AND relforcerowsecurity), 1, false
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('AppointmentEvent_append_only', 'AppointmentEvent_no_truncate') AND NOT tgisinternal), 2, false
  UNION ALL SELECT 15, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND ((column_name = 'defaultApprovalMode' AND column_default LIKE '''MANUAL''%') OR (column_name = 'requireVerification' AND column_default = 'false'))), 2, false
  UNION ALL SELECT 16, (SELECT count(*) FROM "BookingSettings"), NULL, true
  UNION ALL SELECT 17, (SELECT count(*) FROM "NotificationDelivery"), NULL, true
  UNION ALL SELECT 18, (SELECT count(*) FROM "Appointment"), NULL, true
  UNION ALL SELECT 19, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'public_booking' AND "globalEnabled"), 0, false
  UNION ALL SELECT 20, (SELECT count(*) FROM "BookingSettings" WHERE NOT "requireVerification"), NULL, true
  UNION ALL SELECT 21, (SELECT count(*) FROM "BookingSettings" WHERE "defaultApprovalMode"::text = 'MANUAL'), NULL, true
  UNION ALL SELECT 22, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261230090000_appointments_completion'), 0, false
)
SELECT n, CASE WHEN info OR observed = want THEN 'PASS' ELSE 'FAIL' END AS result, observed AS observed_count FROM c ORDER BY n;

ROLLBACK;
