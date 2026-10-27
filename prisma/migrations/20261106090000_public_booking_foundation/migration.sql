-- ============================================================================================================
-- 20261106090000_public_booking_foundation — Milestone C, segments 1–2 (owner-approved 2026-10-27)
--
-- The tables external booking needs already exist since 20261029090000 (BookingSettings, BookingRequest,
-- AppointmentManageToken, ServiceBookingPolicy) with FORCE RLS, constraints and erasure coverage. This migration adds
-- only what the owner's decisions D7–D11 need and what a request without a session needs to find its business:
--
--   1. "StaffMember"."publicBookable" (D7) — a staff member is offered to the public only when the owner says so,
--      separately from the services they perform. Default false: no existing staff member becomes public.
--   2. "BookingSettings" — the business's own choices: how a staff member is picked when the customer does not choose
--      (D8, default BALANCED), self-cancellation and its window (D9, default on, 24 hours), what the public page shows
--      beyond the business name and the services (D10), and a stricter per-phone open-request cap than the platform's
--      (D11). The platform's security ceilings are NOT stored here: they are code constants the owner cannot raise.
--   3. Three SECURITY DEFINER functions, the M6 / task-reminder pattern: pinned search_path, owned by the migration
--      role (BYPASSRLS), EXECUTE revoked from PUBLIC and granted to app_runtime alone. They return IDENTIFIERS ONLY:
--        booking_resolve_public(public id)       → the business that owns an ENABLED booking link (equality on the
--                                                   unique public id; a disabled link, a deleted business or a
--                                                   malformed id resolves to nothing);
--        booking_resolve_manage_token(sha256)    → the business of a live, unrevoked customer manage link (the token
--                                                   itself is never stored, only its hash);
--        booking_pending_due(now, limit)         → pending requests of live businesses (ids and times) for the
--                                                   sweeper that expires them and sends the owner's reminders.
--      Everything after that runs inside the resolved business's tenant transaction, under its RLS.
--
-- Additive only: no existing row, column, policy, grant or constraint is changed or removed. Existing BookingSettings
-- rows (none are written by any code today) take the defaults.
-- ============================================================================================================

-- ── 1. Staff offered to the public (D7) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "StaffMember" ADD COLUMN "publicBookable" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. The business's booking choices (D8–D11) ────────────────────────────────────────────────────────────────

CREATE TYPE "BookingAssignmentMode" AS ENUM ('BALANCED', 'PRIORITY');

ALTER TABLE "BookingSettings"
  ADD COLUMN "assignmentMode" "BookingAssignmentMode" NOT NULL DEFAULT 'BALANCED',
  ADD COLUMN "selfCancelEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "selfCancelWindowHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "maxOpenRequestsPerPhone" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "showAddress" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showBusinessDetails" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showPrices" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showStaffNames" BOOLEAN NOT NULL DEFAULT true;

-- A month at most; 0 = until the start.
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_self_cancel_window"
  CHECK ("selfCancelWindowHours" BETWEEN 0 AND 720);
-- The stored value is the business's own cap; the platform ceiling (code) is applied on top of it.
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_open_per_phone"
  CHECK ("maxOpenRequestsPerPhone" BETWEEN 1 AND 10);

-- ── 3. The two doors without a session (identifiers only) ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.booking_resolve_public(p_public_id text)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT s."businessId"
    FROM public."BookingSettings" s
    JOIN public."Business" b ON b."id" = s."businessId"
   WHERE p_public_id ~ '^[A-Za-z0-9_-]{22,64}$'
     AND s."publicId" = p_public_id
     AND s."enabled" = true
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
$fn$;

CREATE OR REPLACE FUNCTION public.booking_pending_due(p_now timestamp(3), p_limit integer)
RETURNS TABLE ("businessId" integer, "requestId" integer, "createdAt" timestamp(3), "expiresAt" timestamp(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT r."businessId", r."id", r."createdAt", r."expiresAt"
    FROM public."BookingRequest" r
    JOIN public."Business" b ON b."id" = r."businessId"
   WHERE r."status" = 'PENDING'
     AND r."erasedAt" IS NULL
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
     -- due for expiry, or old enough for at least the first reminder (two hours)
     AND (r."expiresAt" <= p_now OR r."createdAt" <= p_now - interval '2 hours')
   ORDER BY r."expiresAt"
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$fn$;

-- The customer's manage link carries a token; only its sha256 is stored. Exact hash, live and unrevoked only.
CREATE OR REPLACE FUNCTION public.booking_resolve_manage_token(p_token_hash text)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT t."businessId"
    FROM public."AppointmentManageToken" t
    JOIN public."Business" b ON b."id" = t."businessId"
   WHERE p_token_hash ~ '^[0-9a-f]{64}$'
     AND t."tokenHash" = p_token_hash
     AND t."revokedAt" IS NULL
     AND t."expiresAt" > now()
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
$fn$;

REVOKE ALL ON FUNCTION public.booking_resolve_public(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.booking_pending_due(timestamp(3), integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.booking_resolve_manage_token(text) FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.booking_resolve_public(text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.booking_pending_due(timestamp(3), integer) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.booking_resolve_manage_token(text) TO app_runtime;
  END IF;
END
$do$;
