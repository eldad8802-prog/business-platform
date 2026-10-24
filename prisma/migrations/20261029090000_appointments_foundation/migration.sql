-- Appointments — data foundation (milestone A, migration only)
--
-- WHAT THIS ADDS
--   "Appointment" is EXTENDED, not replaced (owner decision 1, 2026-10-25). Every existing row keeps its meaning:
--   the new columns are nullable or defaulted, the lifecycle enum is untouched, and the two existing creation paths
--   (owner direct create, conversion of a conversation's pending request) keep working without an end time, a staff
--   member or a kind. New columns: kind (CUSTOMER by default — every existing row is a customer appointment),
--   endsAt, staffMemberId, locationKind / locationDetail, the two buffer snapshots, holdExpiresAt, the actual
--   start / end, cancelReason, version (optimistic lock) and erasedAt.
--
--   "createdByUserId" becomes nullable (owner decision 6): a CUSTOMER (external booking, later) or SYSTEM action is
--   never attributed to the owner. A CHECK keeps the owner's own actions attributable: actor OWNER ⇒ a user. The
--   enum "CreatedByActor" gains CUSTOMER; nothing in this migration uses the new value (it cannot be used in the
--   transaction that adds it).
--
--   Eight new tenant tables:
--     "StaffMember"            — an employee WITHOUT a login (no user, no password, no permission of any kind);
--     "StaffServiceAssignment" — which staff member performs which catalog service;
--     "AvailabilityRule"       — weekly working hours, of the business or of one staff member (wall-clock minutes);
--     "AvailabilityException"  — a day closed, or opened with special hours (holidays, leave);
--     "ServiceBookingPolicy"   — per catalog service: buffers, notice, horizon, slot step, approval mode,
--                                cancellation / reschedule windows (NO payment columns — milestone E);
--     "BookingSettings"        — per business: external booking switch (OFF), public id, approval default, hold
--                                lifetime, staff choice (the external booking itself is milestone D);
--     "BookingRequest"         — an external booking request (milestone D writes it; nothing does yet);
--     "AppointmentManageToken" — the customer's manage link, stored as a hash (milestone D; nothing writes it yet);
--   and the append-only journal "AppointmentEvent".
--   Deliberately NOT here: the appointment ↔ payment link. The payment request table has no tenant key, and adding one is a
--   change to a fiscal table — that belongs to milestone E with its own approval.
--
-- NO OVERLAP (owner decision 2) — two layers
--   1. The application takes a transaction-scoped advisory lock per business and checks availability first, so a
--      conflict is answered with a clear message.
--   2. The database refuses an overlap even under concurrent requests: an EXCLUDE constraint (btree_gist) on
--      (business, staff lane, occupied range). The occupied range is [startsAt − bufferBefore, endsAt + bufferAfter).
--      Only rows with an end time and an active status (PROPOSED, CONFIRMED) take part. Every row that exists today
--      has no end time (the column is new), so NO existing or historical appointment is affected, and the existing
--      creation paths, which write no end time, are never refused by it. A NULL staff member is the business's own
--      lane (COALESCE to 0), so a business without staff is protected too.
--
-- ISOLATION (FORCE RLS, per-command policies, no catch-all, no DELETE anywhere)
--   "Appointment" keeps its three p7pilot_* policies exactly as they are; they cover the new columns. Every new table:
--   ENABLE + FORCE RLS, SELECT / INSERT / UPDATE policies on app.current_business_id (the journal: SELECT / INSERT),
--   explicit grants to app_runtime. Nothing is ever deleted by the runtime: staff are deactivated, rules and
--   assignments are marked removed, requests change status.
--   Cross-tenant references are refused by the database itself: composite (businessId, x) foreign keys for staff,
--   services, appointments, customers and leads, and a trigger for user references ("User" has no tenant key).
--
-- APPEND-ONLY JOURNAL ("AppointmentEvent") — the Daily Tasks journal's shape
--   app_runtime holds SELECT / INSERT only. A trigger refuses every UPDATE and DELETE — for the owner too — except a
--   cascading DELETE (business deletion), the FK action ON DELETE SET NULL of "actorUserId", and the erasure function
--   below. TRUNCATE is refused by a statement trigger. "payload" is a closed shape: an object whose strings are short
--   tokens — no free text can be stored, by construction.
--
-- ACCOUNT ERASURE
--   appointment_erase_business(), EXECUTE for app_runtime: nulls actorUserId and the request digest of the journal of
--   the business in the tenant context, and refuses unless that business is being deleted. The text and contact
--   columns of the other tables are blanked by the account-deletion adapter through ordinary UPDATEs.
--
-- FLAGS — OFF
--   appointments (owner calendar API) and public_booking (external booking, milestone D): definition + policy rows,
--   defaultEnabled false, globalEnabled false.
--
-- Additive, except: "Appointment"."createdByUserId" loses NOT NULL (decision 6), and a same-business trigger is added
-- for that column on new writes. No existing row, column value, index, policy or grant is changed or dropped.
-- A rollback (.appt/rollback.sql) restores the prior state on a database where no new row was written.

-- ── 0. The extension behind the EXCLUDE constraint ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Enums ─────────────────────────────────────────────────────────────────────────────────────

ALTER TYPE "CreatedByActor" ADD VALUE IF NOT EXISTS 'CUSTOMER';

CREATE TYPE "AppointmentKind" AS ENUM ('CUSTOMER', 'INTERNAL', 'BLOCK');
CREATE TYPE "AppointmentLocationKind" AS ENUM ('IN_PERSON', 'PHONE', 'ONLINE');
CREATE TYPE "AppointmentCancelReason" AS ENUM ('OWNER_CANCELED', 'CUSTOMER_CANCELED', 'DECLINED', 'EXPIRED', 'OTHER');
CREATE TYPE "AppointmentEventActor" AS ENUM ('OWNER_USER', 'CUSTOMER', 'SYSTEM');
CREATE TYPE "AppointmentEventType" AS ENUM (
  'APPOINTMENT_CREATED', 'APPOINTMENT_CONFIRMED', 'APPOINTMENT_COMPLETED', 'APPOINTMENT_NO_SHOW',
  'APPOINTMENT_CANCELED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_DETAILS_CHANGED'
);
CREATE TYPE "AvailabilityExceptionKind" AS ENUM ('CLOSED', 'OPEN_HOURS');
CREATE TYPE "BookingApprovalMode" AS ENUM ('MANUAL', 'AUTO');
CREATE TYPE "BookingStaffChoice" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');
CREATE TYPE "BookingRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- ── 2. StaffMember — an employee without a login ─────────────────────────────────────────────────

CREATE TABLE "StaffMember" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "color" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "erasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id"),
  -- Bounded; empty only once account erasure has blanked it.
  CONSTRAINT "StaffMember_name" CHECK (char_length("displayName") <= 80 AND (char_length(btrim("displayName")) > 0 OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "StaffMember_color" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT "StaffMember_sort" CHECK ("sortOrder" BETWEEN 0 AND 10000),
  CONSTRAINT "StaffMember_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "StaffMember_businessId_id_key" ON "StaffMember"("businessId", "id");
CREATE INDEX "StaffMember_businessId_active_idx" ON "StaffMember"("businessId", "active");
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Appointment — the extension ───────────────────────────────────────────────────────────────

ALTER TABLE "Appointment" ALTER COLUMN "createdByUserId" DROP NOT NULL;

ALTER TABLE "Appointment"
  ADD COLUMN "kind" "AppointmentKind" NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN "endsAt" TIMESTAMP(3),
  ADD COLUMN "staffMemberId" INTEGER,
  ADD COLUMN "locationKind" "AppointmentLocationKind",
  ADD COLUMN "locationDetail" TEXT,
  ADD COLUMN "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "holdExpiresAt" TIMESTAMP(3),
  ADD COLUMN "actualStartedAt" TIMESTAMP(3),
  ADD COLUMN "actualEndedAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" "AppointmentCancelReason",
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "erasedAt" TIMESTAMP(3);

-- Decision 6: the owner's own actions stay attributable; a customer or the system is never given a user.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_owner_has_user"
  CHECK ("createdByActor" <> 'OWNER' OR "createdByUserId" IS NOT NULL);
-- An internal meeting or a time block names no customer and always occupies a time range.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_kind_shape"
  CHECK ("kind" = 'CUSTOMER'
         OR ("customerId" IS NULL AND "leadId" IS NULL AND "businessServiceId" IS NULL
             AND "sourceConversationId" IS NULL AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL));
-- An end time needs a start, comes after it, and spans at most a day (longer absences are availability exceptions).
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_time_shape"
  CHECK ("endsAt" IS NULL
         OR ("startsAt" IS NOT NULL AND "endsAt" > "startsAt" AND "endsAt" <= "startsAt" + interval '24 hours'));
-- When both are known they agree.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_duration_consistent"
  CHECK ("endsAt" IS NULL OR "durationMinutes" IS NULL OR "endsAt" = "startsAt" + "durationMinutes" * interval '1 minute');
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_buffers"
  CHECK ("bufferBeforeMinutes" BETWEEN 0 AND 240 AND "bufferAfterMinutes" BETWEEN 0 AND 240);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_actual_shape"
  CHECK ("actualStartedAt" IS NULL OR "actualEndedAt" IS NULL OR "actualEndedAt" > "actualStartedAt");
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_cancel_reason_status"
  CHECK ("cancelReason" IS NULL OR "status" = 'CANCELED');
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_location_detail_length"
  CHECK ("locationDetail" IS NULL OR char_length("locationDetail") <= 300);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_version_positive" CHECK ("version" >= 1);
-- Bounds on the two pre-existing text columns: enforced for every new write, NOT validated against history (an
-- existing row is never rejected or rewritten by this migration).
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_text_length"
  CHECK (("title" IS NULL OR char_length("title") <= 200) AND ("notes" IS NULL OR char_length("notes") <= 4000)) NOT VALID;

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_staffMemberId_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "Appointment_businessId_staffMemberId_startsAt_idx" ON "Appointment"("businessId", "staffMemberId", "startsAt");
CREATE INDEX "Appointment_holdExpiresAt_idx" ON "Appointment"("holdExpiresAt") WHERE "holdExpiresAt" IS NOT NULL;

-- Decision 2, layer 2: no two active appointments of the same lane may occupy overlapping time.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_no_overlap" EXCLUDE USING gist (
  "businessId" WITH =,
  (COALESCE("staffMemberId", 0)) WITH =,
  tsrange("startsAt" - "bufferBeforeMinutes" * interval '1 minute',
          "endsAt" + "bufferAfterMinutes" * interval '1 minute', '[)') WITH &&
) WHERE ("endsAt" IS NOT NULL AND "status" IN ('PROPOSED', 'CONFIRMED'));

-- ── 4. StaffServiceAssignment ────────────────────────────────────────────────────────────────────

CREATE TABLE "StaffServiceAssignment" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "staffMemberId" INTEGER NOT NULL,
  "businessServiceId" INTEGER NOT NULL,
  "durationOverrideMinutes" INTEGER,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffServiceAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffServiceAssignment_duration" CHECK ("durationOverrideMinutes" IS NULL OR "durationOverrideMinutes" BETWEEN 5 AND 1440)
);
-- One live assignment per pair; a removed one stays as history.
CREATE UNIQUE INDEX "StaffServiceAssignment_live_pair_key"
  ON "StaffServiceAssignment"("businessId", "staffMemberId", "businessServiceId") WHERE "removedAt" IS NULL;
CREATE INDEX "StaffServiceAssignment_businessId_businessServiceId_idx" ON "StaffServiceAssignment"("businessId", "businessServiceId");
ALTER TABLE "StaffServiceAssignment" ADD CONSTRAINT "StaffServiceAssignment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffServiceAssignment" ADD CONSTRAINT "StaffServiceAssignment_staffMemberId_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StaffServiceAssignment" ADD CONSTRAINT "StaffServiceAssignment_businessServiceId_tenant_fkey"
  FOREIGN KEY ("businessServiceId", "businessId") REFERENCES "BusinessService"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ── 5. AvailabilityRule — weekly hours (wall-clock minutes in the business's time zone) ───────────

CREATE TABLE "AvailabilityRule" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "staffMemberId" INTEGER,
  "weekday" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "endMinute" INTEGER NOT NULL,
  "validFrom" DATE,
  "validUntil" DATE,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AvailabilityRule_pkey" PRIMARY KEY ("id"),
  -- 0 = Sunday … 6 = Saturday; a window inside one day, start before end.
  CONSTRAINT "AvailabilityRule_window" CHECK (
        "weekday" BETWEEN 0 AND 6
    AND "startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 1 AND 1440
    AND "startMinute" < "endMinute"),
  CONSTRAINT "AvailabilityRule_validity" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil")
);
CREATE INDEX "AvailabilityRule_businessId_staffMemberId_weekday_idx" ON "AvailabilityRule"("businessId", "staffMemberId", "weekday");
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_staffMemberId_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 6. AvailabilityException — a day closed or opened with special hours ─────────────────────────

CREATE TABLE "AvailabilityException" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "staffMemberId" INTEGER,
  "dayKey" DATE NOT NULL,
  "kind" "AvailabilityExceptionKind" NOT NULL,
  "startMinute" INTEGER,
  "endMinute" INTEGER,
  "label" TEXT,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AvailabilityException_pkey" PRIMARY KEY ("id"),
  -- CLOSED: the whole day (no minutes) or part of it; OPEN_HOURS: always a window, replacing that day's weekly hours.
  CONSTRAINT "AvailabilityException_window" CHECK (
        (("startMinute" IS NULL) = ("endMinute" IS NULL))
    AND ("startMinute" IS NULL OR ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 1 AND 1440 AND "startMinute" < "endMinute"))
    AND ("kind" = 'CLOSED' OR "startMinute" IS NOT NULL)),
  CONSTRAINT "AvailabilityException_label_length" CHECK ("label" IS NULL OR char_length("label") <= 80)
);
CREATE INDEX "AvailabilityException_businessId_dayKey_idx" ON "AvailabilityException"("businessId", "dayKey");
ALTER TABLE "AvailabilityException" ADD CONSTRAINT "AvailabilityException_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AvailabilityException" ADD CONSTRAINT "AvailabilityException_staffMemberId_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 7. ServiceBookingPolicy — one per catalog service ────────────────────────────────────────────

CREATE TABLE "ServiceBookingPolicy" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "businessServiceId" INTEGER NOT NULL,
  "publicBookable" BOOLEAN NOT NULL DEFAULT false,
  "approvalMode" "BookingApprovalMode" NOT NULL DEFAULT 'MANUAL',
  "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
  "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
  "minLeadMinutes" INTEGER NOT NULL DEFAULT 0,
  "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
  "slotStepMinutes" INTEGER NOT NULL DEFAULT 15,
  "cancelWindowHours" INTEGER,
  "rescheduleWindowHours" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceBookingPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceBookingPolicy_bounds" CHECK (
        "bufferBeforeMinutes" BETWEEN 0 AND 240 AND "bufferAfterMinutes" BETWEEN 0 AND 240
    AND "minLeadMinutes" BETWEEN 0 AND 20160
    AND "maxAdvanceDays" BETWEEN 1 AND 365
    AND "slotStepMinutes" BETWEEN 5 AND 240
    AND ("cancelWindowHours" IS NULL OR "cancelWindowHours" BETWEEN 0 AND 720)
    AND ("rescheduleWindowHours" IS NULL OR "rescheduleWindowHours" BETWEEN 0 AND 720)),
  CONSTRAINT "ServiceBookingPolicy_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "ServiceBookingPolicy_businessId_businessServiceId_key" ON "ServiceBookingPolicy"("businessId", "businessServiceId");
ALTER TABLE "ServiceBookingPolicy" ADD CONSTRAINT "ServiceBookingPolicy_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceBookingPolicy" ADD CONSTRAINT "ServiceBookingPolicy_businessServiceId_tenant_fkey"
  FOREIGN KEY ("businessServiceId", "businessId") REFERENCES "BusinessService"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ── 8. BookingSettings — one row per business (external booking is OFF until milestone D) ────────

CREATE TABLE "BookingSettings" (
  "businessId" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "publicId" TEXT,
  "timeZone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  "defaultApprovalMode" "BookingApprovalMode" NOT NULL DEFAULT 'MANUAL',
  "pendingTtlMinutes" INTEGER NOT NULL DEFAULT 720,
  "requireVerification" BOOLEAN NOT NULL DEFAULT false,
  "staffChoiceMode" "BookingStaffChoice" NOT NULL DEFAULT 'NONE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingSettings_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "BookingSettings_public_id" CHECK ("publicId" IS NULL OR "publicId" ~ '^[A-Za-z0-9_-]{22,64}$'),
  -- The engine speaks Israel time only; another zone needs its own decision and code.
  CONSTRAINT "BookingSettings_time_zone" CHECK ("timeZone" = 'Asia/Jerusalem'),
  CONSTRAINT "BookingSettings_ttl" CHECK ("pendingTtlMinutes" BETWEEN 15 AND 10080),
  -- Enabling external booking needs a public id.
  CONSTRAINT "BookingSettings_enabled_has_id" CHECK (NOT "enabled" OR "publicId" IS NOT NULL),
  CONSTRAINT "BookingSettings_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "BookingSettings_publicId_key" ON "BookingSettings"("publicId");
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 9. BookingRequest — an external request (milestone D) ────────────────────────────────────────

CREATE TABLE "BookingRequest" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "appointmentId" INTEGER NOT NULL,
  "status" "BookingRequestStatus" NOT NULL DEFAULT 'PENDING',
  "contactName" TEXT NOT NULL,
  "contactPhone" TEXT,
  "contactEmail" TEXT,
  "customerNote" TEXT,
  "fingerprint" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" INTEGER,
  "erasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingRequest_contact" CHECK (
        char_length("contactName") <= 120
    AND ("contactPhone" IS NULL OR "contactPhone" ~ '^[0-9]{8,15}$')
    AND ("contactEmail" IS NULL OR char_length("contactEmail") <= 254)
    AND ("customerNote" IS NULL OR char_length("customerNote") <= 500)
    -- A phone and a name until account erasure takes them.
    AND ("erasedAt" IS NOT NULL OR ("contactPhone" IS NOT NULL AND char_length(btrim("contactName")) > 0))),
  CONSTRAINT "BookingRequest_fingerprint" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BookingRequest_decided" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL))
);
CREATE UNIQUE INDEX "BookingRequest_appointmentId_key" ON "BookingRequest"("appointmentId");
CREATE UNIQUE INDEX "BookingRequest_businessId_fingerprint_key" ON "BookingRequest"("businessId", "fingerprint");
CREATE INDEX "BookingRequest_businessId_status_expiresAt_idx" ON "BookingRequest"("businessId", "status", "expiresAt");
CREATE INDEX "BookingRequest_businessId_contactPhone_idx" ON "BookingRequest"("businessId", "contactPhone");
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_appointmentId_tenant_fkey"
  FOREIGN KEY ("appointmentId", "businessId") REFERENCES "Appointment"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 10. AppointmentManageToken — the customer's manage link, as a hash (milestone D) ─────────────

CREATE TABLE "AppointmentManageToken" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "appointmentId" INTEGER NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentManageToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentManageToken_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AppointmentManageToken_lifetime" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '400 days')
);
CREATE UNIQUE INDEX "AppointmentManageToken_tokenHash_key" ON "AppointmentManageToken"("tokenHash");
CREATE INDEX "AppointmentManageToken_businessId_appointmentId_idx" ON "AppointmentManageToken"("businessId", "appointmentId");
ALTER TABLE "AppointmentManageToken" ADD CONSTRAINT "AppointmentManageToken_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentManageToken" ADD CONSTRAINT "AppointmentManageToken_appointmentId_tenant_fkey"
  FOREIGN KEY ("appointmentId", "businessId") REFERENCES "Appointment"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 11. AppointmentEvent — the append-only journal ──────────────────────────────────────────────

CREATE TABLE "AppointmentEvent" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "appointmentId" INTEGER NOT NULL,
  "eventType" "AppointmentEventType" NOT NULL,
  "actor" "AppointmentEventActor" NOT NULL,
  "actorUserId" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest" TEXT,
  "digestKeyId" TEXT,
  CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id"),
  -- Only the owner's own actions name a user (decision 6).
  CONSTRAINT "AppointmentEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "AppointmentEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))
  ),
  -- A closed payload: an object of numbers, booleans, nulls, arrays and SHORT TOKENS — never free text.
  CONSTRAINT "AppointmentEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "AppointmentEvent_businessId_idempotencyKey_key" ON "AppointmentEvent"("businessId", "idempotencyKey");
CREATE INDEX "AppointmentEvent_businessId_appointmentId_idx" ON "AppointmentEvent"("businessId", "appointmentId");
CREATE INDEX "AppointmentEvent_businessId_occurredAt_idx" ON "AppointmentEvent"("businessId", "occurredAt");
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_tenant_fkey"
  FOREIGN KEY ("appointmentId", "businessId") REFERENCES "Appointment"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 12. User references stay inside the business (trigger; "User" has no tenant key) ─────────────

CREATE OR REPLACE FUNCTION public.appointment_user_same_business()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  col text;
  uid integer;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    uid := (to_jsonb(NEW) ->> col)::integer;
    IF uid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZA03',
        MESSAGE = format('APPOINTMENT_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.appointment_user_same_business() FROM PUBLIC;

-- On "Appointment" it checks new writes of the column only; existing rows are not re-read.
CREATE TRIGGER "Appointment_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId" ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_user_same_business('createdByUserId');
CREATE TRIGGER "BookingRequest_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "decidedByUserId" ON "BookingRequest"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_user_same_business('decidedByUserId');
CREATE TRIGGER "AppointmentEvent_user_same_business"
  BEFORE INSERT ON "AppointmentEvent"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_user_same_business('actorUserId');

-- ── 13. The journal guard ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.appointment_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  -- Inside the erasure function: running AS the table owner AND with the transaction-local marker it sets.
  -- app_runtime can set the marker but can never be the owner.
  in_erasure boolean :=
        current_setting('dubiz.appointment_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId'];
  only_nulled boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;  -- a cascade from Business
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    only_nulled :=
          (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
      AND (NEW."actorUserId"   IS NULL OR NEW."actorUserId"   IS NOT DISTINCT FROM OLD."actorUserId")
      AND (NEW."requestDigest" IS NULL OR NEW."requestDigest" IS NOT DISTINCT FROM OLD."requestDigest")
      AND (NEW."digestKeyId"   IS NULL OR NEW."digestKeyId"   IS NOT DISTINCT FROM OLD."digestKeyId");
    IF only_nulled AND in_erasure THEN
      RETURN NEW;
    END IF;
    -- The FK action of "actorUserId" (ON DELETE SET NULL): that column alone, to NULL.
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZA01',
    MESSAGE = format('APPOINTMENT_EVENT_APPEND_ONLY: %s on %I is refused; the appointment journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.appointment_event_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.appointment_event_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'DZA01',
    MESSAGE = format('APPOINTMENT_EVENT_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.appointment_event_truncate_guard() FROM PUBLIC;

CREATE TRIGGER "AppointmentEvent_append_only" BEFORE UPDATE OR DELETE ON "AppointmentEvent"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_event_append_only_guard();
CREATE TRIGGER "AppointmentEvent_no_truncate" BEFORE TRUNCATE ON "AppointmentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.appointment_event_truncate_guard();

-- ── 14. Account erasure — the runtime's one path into the journal ───────────────────────────────

-- Nulls the acting user and the request digest of every event of the business in the tenant context — nothing else,
-- no other column, no other business — and only while that business is being deleted (deletionRequestedAt or
-- deletedAt set). The account-deletion flow calls it inside its tenant transaction; for an active business it refuses.
CREATE OR REPLACE FUNCTION public.appointment_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'APPOINTMENT_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA04', MESSAGE = 'APPOINTMENT_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.appointment_erasure', 'on', true);
  UPDATE "AppointmentEvent" e SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE e."businessId" = v_business
     AND (e."actorUserId" IS NOT NULL OR e."requestDigest" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.appointment_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.appointment_erase_business() FROM PUBLIC;

-- ── 15. Row-level security ──────────────────────────────────────────────────────────────────────

ALTER TABLE "StaffMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_member_tenant_select ON "StaffMember" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY staff_member_tenant_insert ON "StaffMember" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY staff_member_tenant_update ON "StaffMember" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "StaffServiceAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffServiceAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_assignment_tenant_select ON "StaffServiceAssignment" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY staff_assignment_tenant_insert ON "StaffServiceAssignment" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY staff_assignment_tenant_update ON "StaffServiceAssignment" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AvailabilityRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvailabilityRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_rule_tenant_select ON "AvailabilityRule" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY availability_rule_tenant_insert ON "AvailabilityRule" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY availability_rule_tenant_update ON "AvailabilityRule" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AvailabilityException" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvailabilityException" FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_exception_tenant_select ON "AvailabilityException" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY availability_exception_tenant_insert ON "AvailabilityException" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY availability_exception_tenant_update ON "AvailabilityException" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceBookingPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceBookingPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_booking_policy_tenant_select ON "ServiceBookingPolicy" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_booking_policy_tenant_insert ON "ServiceBookingPolicy" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_booking_policy_tenant_update ON "ServiceBookingPolicy" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BookingSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_settings_tenant_select ON "BookingSettings" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_settings_tenant_insert ON "BookingSettings" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_settings_tenant_update ON "BookingSettings" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BookingRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_request_tenant_select ON "BookingRequest" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_request_tenant_insert ON "BookingRequest" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_request_tenant_update ON "BookingRequest" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AppointmentManageToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentManageToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_token_tenant_select ON "AppointmentManageToken" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY appointment_token_tenant_insert ON "AppointmentManageToken" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY appointment_token_tenant_update ON "AppointmentManageToken" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "AppointmentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_event_tenant_select ON "AppointmentEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY appointment_event_tenant_insert ON "AppointmentEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 16. Privileges — named explicitly ───────────────────────────────────────────────────────────

REVOKE ALL ON "StaffMember", "StaffServiceAssignment", "AvailabilityRule", "AvailabilityException",
              "ServiceBookingPolicy", "BookingSettings", "BookingRequest", "AppointmentManageToken",
              "AppointmentEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "StaffMember_id_seq", "StaffServiceAssignment_id_seq", "AvailabilityRule_id_seq",
              "AvailabilityException_id_seq", "ServiceBookingPolicy_id_seq", "BookingRequest_id_seq",
              "AppointmentManageToken_id_seq", "AppointmentEvent_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first (the Daily Tasks G4
-- finding: Production's default privileges grant more than a migration names). "Appointment" itself is not in this
-- list: its existing grants are left exactly as they are.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('StaffMember', 'StaffServiceAssignment', 'AvailabilityRule', 'AvailabilityException',
                         'ServiceBookingPolicy', 'BookingSettings', 'BookingRequest', 'AppointmentManageToken',
                         'AppointmentEvent',
                         'StaffMember_id_seq', 'StaffServiceAssignment_id_seq', 'AvailabilityRule_id_seq',
                         'AvailabilityException_id_seq', 'ServiceBookingPolicy_id_seq', 'BookingRequest_id_seq',
                         'AppointmentManageToken_id_seq', 'AppointmentEvent_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', r.rel, r.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
    END IF;
  END LOOP;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Read, add, change — never remove: staff are deactivated, rules and assignments are marked removed.
    GRANT SELECT, INSERT, UPDATE ON "StaffMember", "StaffServiceAssignment", "AvailabilityRule",
                                    "AvailabilityException", "ServiceBookingPolicy", "BookingSettings",
                                    "BookingRequest", "AppointmentManageToken" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "StaffMember", "StaffServiceAssignment", "AvailabilityRule",
                                    "AvailabilityException", "ServiceBookingPolicy", "BookingSettings",
                                    "BookingRequest", "AppointmentManageToken" FROM app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "StaffMember_id_seq", "StaffServiceAssignment_id_seq", "AvailabilityRule_id_seq",
                                    "AvailabilityException_id_seq", "ServiceBookingPolicy_id_seq", "BookingRequest_id_seq",
                                    "AppointmentManageToken_id_seq" TO app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "AppointmentEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "AppointmentEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AppointmentEvent" FROM app_runtime;

    -- Account erasure runs as the runtime, inside the erased business's tenant transaction (the function checks both).
    GRANT EXECUTE ON FUNCTION public.appointment_erase_business() TO app_runtime;
  END IF;
END
$do$;

-- ── 17. The flags — OFF ───────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('appointments', 'יומן ותורים', 'scheduling', 'יומן, תורים, עובדים וזמינות לבעל העסק — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('public_booking', 'הזמנת תורים חיצונית', 'scheduling', 'קישור הזמנות ציבורי ללקוחות — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('appointments', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('public_booking', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
