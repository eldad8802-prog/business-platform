-- ============================================================================
-- appointments-completion-production-evidence.sql
--
-- Read-only PROOF, after migration
--   20261230090000_appointments_completion
-- was applied: the reviewed file (sha256 pinned below) is the one recorded, its objects exist exactly as reviewed,
-- and nothing was turned on or written by it.
--
--   1. series (G5): "AppointmentSeries" under FORCED RLS with its three policies; "Appointment".seriesId/seriesIndex;
--   2. journal: AppointmentEventType holds the 7 original + 7 new labels; the journal guards are still in place;
--   3. booking settings: five new columns NOT NULL with defaults; the two changed defaults (AUTO, true) apply to new
--      rows only — existing rows are counted, never rewritten;
--   4. phone verification: "BookingPhoneChallenge" under FORCED RLS; "BookingRequest".phoneVerifiedAt;
--   5. customer WhatsApp: NotificationChannel holds WHATSAPP; the eight "NotificationDelivery" columns, their
--      constraints and indexes; the two SECURITY DEFINER functions with EXECUTE for app_runtime only;
--   and: nothing is written yet (no series, no challenge, no customer delivery), public_booking is still OFF, the
--   ledger is clean, app_runtime is still a plain role, PUBLIC / app_auth hold nothing on the new tables.
--
-- OUTPUT (redaction-friendly): n | PASS/FAIL | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== appointments completion proof: legend (n -> check) =='
\echo ' 1 the migration is recorded, finished, not rolled back, with checksum 8d8a7d17…de29'
\echo ' 2 exactly one ledger row carries this migration name'
\echo ' 3 ledger: no unfinished and no rolled-back row'
\echo ' 4 AppointmentSeries and BookingPhoneChallenge: RLS enabled and forced (observed = of 2)'
\echo ' 5 their policies: 6, one per read / add / change command, none for removal and none for every command (observed = policies)'
\echo ' 6 the 16 new columns exist (observed = of 16)'
\echo ' 7 AppointmentEventType: 14 labels, the 7 new ones included (observed = labels)'
\echo ' 8 NotificationChannel: IN_APP, PUSH, WHATSAPP (observed = labels)'
\echo ' 9 AppointmentSeriesFrequency: WEEKLY, BIWEEKLY (observed = labels)'
\echo '10 the fifteen new indexes exist (observed = of 15)'
\echo '11 the 28 new constraints exist and are validated (observed = of 28)'
\echo '12 BookingSettings: the five new columns NOT NULL with defaults (observed = of 5)'
\echo '13 BookingSettings: new-row defaults are AUTO and true (observed = of 2)'
\echo '14 BookingSettings rows created before the release (info: their values are their own)'
\echo '15 the five definer functions: SECURITY DEFINER, search_path pinned (observed = of 5)'
\echo '16 ...owned by a BYPASSRLS (or superuser) role (observed = of 5)'
\echo '17 ...EXECUTE for app_runtime (observed = of 5)'
\echo '18 ...and for neither PUBLIC nor app_auth (observed = grants found)'
\echo '19 app_runtime on the two new tables: exactly read / add / change, nothing else (observed = of 2)'
\echo '20 PUBLIC and app_auth hold no table privilege on the two new tables (observed = privileges found)'
\echo '21 AppointmentEvent: both journal-guard triggers still exist (observed = of 2)'
\echo '22 NotificationDelivery: RLS still enabled and forced'
\echo '23 nothing written yet: series + challenges + customer deliveries + appointments in a series (want 0)'
\echo '24 public_booking: globally OFF (observed = policies globally ON)'
\echo '25 app_runtime is still NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '26 BookingSettings rows created before the release with requireVerification = false (info: equal to preflight line 20 — stored settings unchanged)'
\echo '27 BookingSettings rows created before the release with defaultApprovalMode = MANUAL (info: equal to preflight line 21)'
\echo '28 the challenge guard and the customer-delivery guard triggers exist (observed = of 2)'
\echo '29 the challenge lifetime defaults to 5 minutes (want 1)'
\echo '30 one open challenge per phone and one customer delivery per message: both partial indexes are unique (observed = of 2)'
\echo '31 no challenge older than 8 days and no customer phone older than 31 days remain (the sweeps; want 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.proowner, p.proacl
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'public' AND p.proname IN ('notification_whatsapp_due', 'notification_delivery_by_provider_message', 'booking_otp_send_counts',
                                                'booking_phone_challenge_purge', 'notification_customer_phone_purge')
), released AS (
  SELECT min(finished_at) AS at FROM "_prisma_migrations" WHERE migration_name = '20261230090000_appointments_completion'
), c(n, observed, want, info) AS (
            SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261230090000_appointments_completion'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND checksum = '8d8a7d17304bd6283ab20abedb5617e75b15fef07e2c1b9c594a2ee605d4de29'), 1::bigint, false
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261230090000_appointments_completion'), 1, false
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0, false
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('AppointmentSeries', 'BookingPhoneChallenge')
      AND relrowsecurity AND relforcerowsecurity), 2, false
  UNION ALL SELECT 5, (SELECT count(*) + 100 * count(*) FILTER (WHERE left(cmd, 1) NOT IN ('S', 'I', 'U')) FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('AppointmentSeries', 'BookingPhoneChallenge')), 6, false
  UNION ALL SELECT 6, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
         (table_name = 'Appointment' AND column_name IN ('seriesId', 'seriesIndex'))
      OR (table_name = 'BookingSettings' AND column_name IN ('selfRescheduleEnabled', 'selfRescheduleWindowHours', 'reminderOffsetsMinutes', 'bookingHorizonDays', 'showLogo'))
      OR (table_name = 'BookingRequest' AND column_name = 'phoneVerifiedAt')
      OR (table_name = 'NotificationDelivery' AND column_name IN ('recipientKind', 'recipientPhone', 'templateKey', 'messageClass', 'providerMessageId',
                                                                  'providerStatus', 'providerUpdatedAt', 'appointmentId')))), 16, false
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AppointmentEventType'
      AND (e.enumlabel LIKE 'APPOINTMENT\_%' OR e.enumlabel IN ('ARRIVED', 'STATUS_CORRECTED', 'CUSTOMER_CHANGED', 'SERVICE_CHANGED',
                                                                'SERIES_CREATED', 'SERIES_CHANGED', 'SELF_RESCHEDULED'))), 14, false
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationChannel'
      AND e.enumlabel IN ('IN_APP', 'PUSH', 'WHATSAPP')), 3, false
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AppointmentSeriesFrequency'
      AND e.enumlabel IN ('WEEKLY', 'BIWEEKLY')), 2, false
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i' AND relname IN (
      'AppointmentSeries_id_businessId_key', 'AppointmentSeries_businessId_cancelledAt_idx', 'Appointment_businessId_seriesId_seriesIndex_key',
      'BookingPhoneChallenge_businessId_phoneHash_createdAt_idx', 'BookingPhoneChallenge_ipHash_createdAt_idx',
      'NotificationDelivery_whatsapp_owed_idx', 'NotificationDelivery_providerMessageId_key', 'NotificationDelivery_businessId_appointmentId_idx',
      'NotificationDelivery_customer_sent_idx', 'BookingPhoneChallenge_businessId_createdAt_idx', 'BookingPhoneChallenge_phoneHash_createdAt_idx',
      'BookingPhoneChallenge_createdAt_idx', 'BookingPhoneChallenge_one_open_key', 'NotificationDelivery_customer_one_per_notification_key',
      'NotificationDelivery_customer_phone_retention_idx')), 15, false
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN (
      'AppointmentSeries_rule', 'AppointmentSeries_end', 'AppointmentSeries_kind_shape', 'AppointmentSeries_title_length',
      'AppointmentSeries_version_positive', 'AppointmentSeries_staffMemberId_tenant_fkey', 'AppointmentSeries_businessServiceId_tenant_fkey',
      'AppointmentSeries_customerId_tenant_fkey', 'AppointmentSeries_createdByUserId_fkey', 'AppointmentSeries_businessId_fkey',
      'Appointment_series_shape', 'Appointment_seriesId_tenant_fkey', 'BookingSettings_self_reschedule_window',
      'BookingSettings_reminder_offsets', 'BookingSettings_horizon', 'BookingPhoneChallenge_hashes', 'BookingPhoneChallenge_counters',
      'BookingPhoneChallenge_lifetime', 'BookingPhoneChallenge_consumed_after_verified', 'BookingPhoneChallenge_superseded_unverified', 'BookingPhoneChallenge_businessId_fkey',
      'NotificationDelivery_recipient_kind', 'NotificationDelivery_customer_channel', 'NotificationDelivery_recipient_phone',
      'NotificationDelivery_whatsapp_shape', 'NotificationDelivery_whatsapp_tokens', 'NotificationDelivery_provider_status_shape',
      'NotificationDelivery_appointmentId_tenant_fkey')), 28, false
  UNION ALL SELECT 12, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND column_name IN ('selfRescheduleEnabled', 'selfRescheduleWindowHours', 'reminderOffsetsMinutes', 'bookingHorizonDays', 'showLogo')
      AND is_nullable = 'NO' AND column_default IS NOT NULL), 5, false
  UNION ALL SELECT 13, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND ((column_name = 'defaultApprovalMode' AND column_default LIKE '''AUTO''%') OR (column_name = 'requireVerification' AND column_default = 'true'))), 2, false
  UNION ALL SELECT 14, (SELECT count(*) FROM "BookingSettings", released WHERE "createdAt" < released.at), NULL, true
  UNION ALL SELECT 15, (SELECT count(*) FROM f WHERE prosecdef AND array_to_string(proconfig, ',') = 'search_path=pg_catalog, public, pg_temp'), 5, false
  UNION ALL SELECT 16, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner WHERE r.rolbypassrls OR r.rolsuper), 5, false
  UNION ALL SELECT 17, (SELECT count(*) FROM f WHERE has_function_privilege('app_runtime', f.oid, 'EXECUTE')), 5, false
  UNION ALL SELECT 18, (SELECT count(*) FROM f, aclexplode(f.proacl) a
      WHERE a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'))), 0, false
  -- The runtime's privilege kinds on each table, by first letter: exactly S(elect), I(nsert), U(pdate).
  UNION ALL SELECT 19, (SELECT count(*) FROM (
      SELECT t.oid FROM pg_class t CROSS JOIN LATERAL aclexplode(t.relacl) a
       WHERE t.relnamespace = 'public'::regnamespace AND t.relname IN ('AppointmentSeries', 'BookingPhoneChallenge')
         AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')
       GROUP BY t.oid HAVING string_agg(left(a.privilege_type, 1), '' ORDER BY left(a.privilege_type, 1)) = 'ISU') k), 2, false
  UNION ALL SELECT 20, (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
      AND table_name IN ('AppointmentSeries', 'BookingPhoneChallenge') AND grantee IN ('PUBLIC', 'app_auth')), 0, false
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('AppointmentEvent_append_only', 'AppointmentEvent_no_truncate') AND NOT tgisinternal), 2, false
  UNION ALL SELECT 22, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'NotificationDelivery' AND relrowsecurity AND relforcerowsecurity), 1, false
  UNION ALL SELECT 23, (SELECT count(*) FROM "AppointmentSeries") + (SELECT count(*) FROM "BookingPhoneChallenge")
      + (SELECT count(*) FROM "NotificationDelivery" WHERE "recipientKind" <> 'USER') + (SELECT count(*) FROM "Appointment" WHERE "seriesId" IS NOT NULL), 0, false
  UNION ALL SELECT 24, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'public_booking' AND "globalEnabled"), 0, false
  UNION ALL SELECT 25, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1, false
  UNION ALL SELECT 26, (SELECT count(*) FROM "BookingSettings", released WHERE "createdAt" < released.at AND NOT "requireVerification"), NULL, true
  UNION ALL SELECT 27, (SELECT count(*) FROM "BookingSettings", released WHERE "createdAt" < released.at AND "defaultApprovalMode"::text = 'MANUAL'), NULL, true
  UNION ALL SELECT 28, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('BookingPhoneChallenge_guard', 'NotificationDelivery_customer_guard') AND NOT tgisinternal), 2, false
  UNION ALL SELECT 29, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingPhoneChallenge'
      AND column_name = 'expiresAt' AND column_default LIKE '%00:05:00%'), 1, false
  UNION ALL SELECT 30, (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('BookingPhoneChallenge_one_open_key', 'NotificationDelivery_customer_one_per_notification_key') AND i.indisunique AND i.indpred IS NOT NULL), 2, false
  UNION ALL SELECT 31, (SELECT count(*) FROM "BookingPhoneChallenge" WHERE "createdAt" < now() - interval '8 days')
      + (SELECT count(*) FROM "NotificationDelivery" WHERE "recipientPhone" IS NOT NULL AND "createdAt" < now() - interval '31 days'), 0, false
)
SELECT n, CASE WHEN info OR observed = want THEN 'PASS' ELSE 'FAIL' END AS result, observed AS observed_count FROM c ORDER BY n;

ROLLBACK;
