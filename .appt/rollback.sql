-- Reversal of 20261029090000_appointments_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted first).
-- It REFUSES while any new table holds a row, while any appointment uses a new column (an end time, a staff member,
-- a non-customer kind, a missing creator, a cancel reason, a CUSTOMER actor …), or while any business has an
-- appointments / public_booking flag override: discarding a calendar, a staff list, a journal or a request is a
-- separate, explicit owner decision — never a side effect of a rollback.
--
-- Two residues by design:
--   * the CUSTOMER value stays in the "CreatedByActor" enum — PostgreSQL cannot remove an enum value, and the guard
--     below has just proved no row uses it; a later release re-adds nothing (ADD VALUE IF NOT EXISTS);
--   * btree_gist is dropped only when nothing else depends on it (RESTRICT): if another object uses it, the rollback
--     stops there and changes nothing.
-- It removes its own ledger row in the same transaction, so a later release re-applies the migration whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "StaffMember") OR EXISTS (SELECT 1 FROM "StaffServiceAssignment")
     OR EXISTS (SELECT 1 FROM "AvailabilityRule") OR EXISTS (SELECT 1 FROM "AvailabilityException")
     OR EXISTS (SELECT 1 FROM "ServiceBookingPolicy") OR EXISTS (SELECT 1 FROM "BookingSettings")
     OR EXISTS (SELECT 1 FROM "BookingRequest") OR EXISTS (SELECT 1 FROM "AppointmentManageToken")
     OR EXISTS (SELECT 1 FROM "AppointmentEvent")
     OR EXISTS (SELECT 1 FROM "Appointment"
                 WHERE "kind" <> 'CUSTOMER' OR "endsAt" IS NOT NULL OR "staffMemberId" IS NOT NULL
                    OR "locationKind" IS NOT NULL OR "locationDetail" IS NOT NULL
                    OR "bufferBeforeMinutes" <> 0 OR "bufferAfterMinutes" <> 0 OR "holdExpiresAt" IS NOT NULL
                    OR "actualStartedAt" IS NOT NULL OR "actualEndedAt" IS NOT NULL OR "cancelReason" IS NOT NULL
                    OR "version" <> 1 OR "erasedAt" IS NOT NULL
                    OR "createdByUserId" IS NULL OR "createdByActor"::text = 'CUSTOMER')
     OR EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('appointments', 'public_booking')) THEN
    RAISE EXCEPTION 'appointments rollback refused: rows exist (an owner decision is required first)';
  END IF;
END
$rb$;

DROP TABLE "AppointmentEvent", "AppointmentManageToken", "BookingRequest", "BookingSettings", "ServiceBookingPolicy",
           "AvailabilityException", "AvailabilityRule", "StaffServiceAssignment" CASCADE;

DROP TRIGGER "Appointment_user_same_business" ON "Appointment";
ALTER TABLE "Appointment"
  DROP CONSTRAINT "Appointment_no_overlap",
  DROP CONSTRAINT "Appointment_staffMemberId_tenant_fkey",
  DROP CONSTRAINT "Appointment_owner_has_user",
  DROP CONSTRAINT "Appointment_kind_shape",
  DROP CONSTRAINT "Appointment_time_shape",
  DROP CONSTRAINT "Appointment_duration_consistent",
  DROP CONSTRAINT "Appointment_buffers",
  DROP CONSTRAINT "Appointment_actual_shape",
  DROP CONSTRAINT "Appointment_cancel_reason_status",
  DROP CONSTRAINT "Appointment_location_detail_length",
  DROP CONSTRAINT "Appointment_version_positive",
  DROP CONSTRAINT "Appointment_text_length";
DROP INDEX "Appointment_businessId_staffMemberId_startsAt_idx";
DROP INDEX "Appointment_holdExpiresAt_idx";
ALTER TABLE "Appointment"
  DROP COLUMN "kind", DROP COLUMN "endsAt", DROP COLUMN "staffMemberId", DROP COLUMN "locationKind",
  DROP COLUMN "locationDetail", DROP COLUMN "bufferBeforeMinutes", DROP COLUMN "bufferAfterMinutes",
  DROP COLUMN "holdExpiresAt", DROP COLUMN "actualStartedAt", DROP COLUMN "actualEndedAt",
  DROP COLUMN "cancelReason", DROP COLUMN "version", DROP COLUMN "erasedAt";
ALTER TABLE "Appointment" ALTER COLUMN "createdByUserId" SET NOT NULL;
DROP TABLE "StaffMember";

DROP FUNCTION public.appointment_erase_business();
DROP FUNCTION public.appointment_event_append_only_guard();
DROP FUNCTION public.appointment_event_truncate_guard();
DROP FUNCTION public.appointment_user_same_business();

DROP TYPE "AppointmentKind", "AppointmentLocationKind", "AppointmentCancelReason", "AppointmentEventActor",
          "AppointmentEventType", "AvailabilityExceptionKind", "BookingApprovalMode", "BookingStaffChoice",
          "BookingRequestStatus";

DROP EXTENSION IF EXISTS btree_gist RESTRICT;

DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('appointments', 'public_booking');
DELETE FROM "PlatformFeatureDefinition" WHERE "key" IN ('appointments', 'public_booking');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029090000_appointments_foundation';
COMMIT;
