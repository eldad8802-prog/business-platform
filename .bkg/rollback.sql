-- Rollback of 20261106090000_public_booking_foundation — for a database where nothing used it yet.
-- Refused (raises, changes nothing) while any staff member is offered on a link, any link is enabled, or any booking
-- request or manage token exists: those are the owner's or a customer's data and must not be dropped silently.
-- Otherwise removes exactly what the migration added, in one transaction, and its ledger row.
BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "StaffMember" WHERE "publicBookable")
     OR EXISTS (SELECT 1 FROM "BookingSettings" WHERE enabled)
     OR EXISTS (SELECT 1 FROM "BookingRequest")
     OR EXISTS (SELECT 1 FROM "AppointmentManageToken") THEN
    RAISE EXCEPTION 'public booking rollback refused: the foundation is in use';
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.booking_resolve_public(text);
DROP FUNCTION IF EXISTS public.booking_pending_due(timestamp(3), integer);
DROP FUNCTION IF EXISTS public.booking_resolve_manage_token(text);
ALTER TABLE "BookingSettings" DROP CONSTRAINT IF EXISTS "BookingSettings_self_cancel_window";
ALTER TABLE "BookingSettings" DROP CONSTRAINT IF EXISTS "BookingSettings_open_per_phone";
ALTER TABLE "BookingSettings"
  DROP COLUMN IF EXISTS "assignmentMode", DROP COLUMN IF EXISTS "selfCancelEnabled",
  DROP COLUMN IF EXISTS "selfCancelWindowHours", DROP COLUMN IF EXISTS "maxOpenRequestsPerPhone",
  DROP COLUMN IF EXISTS "showAddress", DROP COLUMN IF EXISTS "showBusinessDetails",
  DROP COLUMN IF EXISTS "showPrices", DROP COLUMN IF EXISTS "showStaffNames";
DROP TYPE IF EXISTS "BookingAssignmentMode";
ALTER TABLE "StaffMember" DROP COLUMN IF EXISTS "publicBookable";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation';
COMMIT;
