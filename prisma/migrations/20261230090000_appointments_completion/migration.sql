-- ============================================================================================================
-- 20261226090000_appointments_completion — appointments to commercial grade: the ONE migration package
-- (owner-approved program 2026-11-24, workstream DB). Migration-first: nothing in the application reads or writes any
-- object below until the stacked code PRs (E recurring + arrival, F customer WhatsApp, G secure self-service) ship
-- AFTER this is applied.
--
-- WHAT THIS ADDS (SPEC "Migration package", items 1–5)
--   1. Recurring appointments (G5): a new tenant table "AppointmentSeries" (a weekly / bi-weekly rule: weekday,
--      wall-clock start minute, duration, optional staff member / catalog service / customer, start date, and EXACTLY ONE
--      of an end date or an occurrence count — no open-ended series, owner decision) and "Appointment"."seriesId" + "seriesIndex" (nullable, every existing row stays
--      outside any series). Composite tenant FKs, so an occurrence can never name another business's series; one row
--      per (series, index) — the materializer's idempotency anchor.
--   2. Journal (G5, G6, G12): "AppointmentEventType" gains ARRIVED, STATUS_CORRECTED, CUSTOMER_CHANGED,
--      SERVICE_CHANGED, SERIES_CREATED, SERIES_CHANGED, SELF_RESCHEDULED. The closed-payload CHECK
--      ("AppointmentEvent_payload_closed") already accepts any short token, so the new events' payloads (status /
--      kind tokens, ids, minutes) need no change to it: it is left exactly as it is, and so is the append-only guard.
--   3. Booking settings (D4, G15, G16): self-reschedule switch + window, reminder offsets (0–3 values, each
--      30..10080 minutes), the booking horizon (1..365 days), show-logo. The DEFAULTS of "defaultApprovalMode"
--      (→ AUTO) and "requireVerification" (→ true) change for rows created from now on; SET DEFAULT rewrites no row,
--      so every existing row keeps exactly what it holds.
--   4. Phone verification (G2): a new tenant table "BookingPhoneChallenge" (hashes only — never a phone number or a
--      code in clear; 5-minute default lifetime; single use and supersede-on-reissue enforced by a trigger and a
--      partial unique index; platform-wide send counts and a retention sweep through two definer functions) and
--      "BookingRequest"."phoneVerifiedAt".
--   5. Customer WhatsApp through the central notification engine (G1, G13): "NotificationChannel" gains WHATSAPP;
--      "NotificationDelivery" gains the customer-recipient columns (recipientKind, recipientPhone, templateKey,
--      messageClass), the provider's id and status, and the appointment it is about (composite tenant FK). ONE row per
--      logical customer message (partial unique index on notificationId) and a guard trigger (provider id written
--      once, provider status monotonic, repeated / out-of-order webhooks ignored, never owed again once sent) — push
--      and in-app rows never reach the trigger. SECURITY DEFINER doors for the worker, the status webhook and the
--      phone-retention sweep (identifiers or counts only), the same pattern as notification_push_due(). Usage
--      metering is a COUNT over these rows (an index below); no meter table.
--
-- ENUM VALUES AND THE TRANSACTION
--   `ALTER TYPE … ADD VALUE` adds a label that cannot be USED inside the transaction that added it (prisma migrate
--   deploy runs this file as one transaction). Nothing below uses a new label: the WHATSAPP ↔ CUSTOMER rule compares
--   "channel"::text, and the worker's index and doors key on "recipientKind" (a text column), never on the enum label.
--   The same approach as 20261029090000 ('CUSTOMER' added to "CreatedByActor", unused in that migration).
--
-- PRIVACY
--   recipientPhone exists only on a CUSTOMER delivery (CHECK) and has the E.164 shape; a USER delivery carries none
--   of the WhatsApp columns. BookingPhoneChallenge holds keyed hashes only. Erasure: AppointmentSeries.title /
--   customerId, BookingPhoneChallenge hashes and NotificationDelivery.recipientPhone are all clearable by the
--   runtime's ordinary UPDATE inside the erased business's tenant transaction (the shapes allow the erased state);
--   the adapter lines ship with the stacked code PRs (the migration-first guard forbids code in this PR) and the
--   erasure registry records them as tracked debt until then.
--
-- RETENTION (documented; the sweeps are called by the application's existing cron)
--   BookingPhoneChallenge: 7 days (never less than 24 h — the cap window). NotificationDelivery.recipientPhone: 30
--   days after the message is no longer owed (never less than 24 h). Account deletion clears both in place earlier.
--
-- ISOLATION (FORCE RLS, per-command policies, no DELETE for the runtime)
--   The two new tables: ENABLE + FORCE RLS, SELECT / INSERT / UPDATE policies on app.current_business_id, explicit
--   grants to app_runtime, everything the migration role's DEFAULT PRIVILEGES handed out revoked first. "Appointment",
--   "BookingSettings", "BookingRequest" and "NotificationDelivery" keep their policies and grants exactly as they are.
--
-- Additive only. No existing row, column value, constraint, index, policy, grant or trigger is changed or dropped;
-- two column DEFAULTS change (item 3, new rows only). Not reversible by a down-migration in place (enum labels
-- cannot be dropped): the safe rollback is a CODE rollback with this schema left in place — every new column is
-- nullable or defaulted, so the previous application keeps working on it.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public."AppointmentSeries"') IS NOT NULL OR to_regclass('public."BookingPhoneChallenge"') IS NOT NULL THEN
    RAISE EXCEPTION 'APPOINTMENTS_COMPLETION: already applied ("AppointmentSeries" or "BookingPhoneChallenge" exists); nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'APPOINTMENTS_COMPLETION: role app_runtime is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key') THEN
    RAISE EXCEPTION 'APPOINTMENTS_COMPLETION: "Customer" ("businessId", "id") key is missing; nothing was changed';
  END IF;
  IF to_regclass('public."Appointment_id_businessId_key"') IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENTS_COMPLETION: "Appointment" ("id", "businessId") key is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.appointment_user_same_business()') IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENTS_COMPLETION: the appointments foundation (20261029090000) is missing; nothing was changed';
  END IF;
END
$do$;
-- Each FK briefly locks the table it references: wait at most 5 s for a lock instead of queueing behind a long one.
SET lock_timeout = '5s';

-- ── 1. Enums ────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'ARRIVED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'STATUS_CORRECTED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'CUSTOMER_CHANGED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'SERVICE_CHANGED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'SERIES_CREATED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'SERIES_CHANGED';
ALTER TYPE "AppointmentEventType" ADD VALUE IF NOT EXISTS 'SELF_RESCHEDULED';
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';
CREATE TYPE "AppointmentSeriesFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY');

-- ── 2. AppointmentSeries — a recurring rule (G5) ────────────────────────────────────────────────────────────
-- Weeks between two occurrences = "interval" for WEEKLY (1..4), 2 for BIWEEKLY ("interval" stays 1). Wall-clock minutes
-- of the business's time zone, like "AvailabilityRule". Ends on a date OR after a number of occurrences — exactly one
-- of the two (owner decision: no open-ended series). Cancelled, never deleted.
CREATE TABLE "AppointmentSeries" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "frequency" "AppointmentSeriesFrequency" NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  "weekday" INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "staffMemberId" INTEGER,
  "businessServiceId" INTEGER,
  "customerId" INTEGER,
  "kind" "AppointmentKind" NOT NULL DEFAULT 'CUSTOMER',
  "title" TEXT,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE,
  "occurrenceCount" INTEGER,
  "createdByUserId" INTEGER,
  "cancelledAt" TIMESTAMP(3),
  "erasedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppointmentSeries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentSeries_rule" CHECK (
        "weekday" BETWEEN 0 AND 6
    AND "startMinute" BETWEEN 0 AND 1439
    AND "durationMinutes" BETWEEN 5 AND 1440
    AND (("frequency" = 'WEEKLY' AND "interval" BETWEEN 1 AND 4) OR ("frequency" = 'BIWEEKLY' AND "interval" = 1))),
  -- Owner decision 2026-11-24: NO open-ended series — exactly one of an end date or a number of occurrences, and
  -- never more than two years ahead (a bound, not a product number: 104 weekly occurrences = two years).
  CONSTRAINT "AppointmentSeries_end" CHECK (
        (("endsOn" IS NULL) <> ("occurrenceCount" IS NULL))
    AND ("endsOn" IS NULL OR ("endsOn" >= "startsOn" AND "endsOn" <= "startsOn" + 730))
    AND ("occurrenceCount" IS NULL OR "occurrenceCount" BETWEEN 1 AND 104)),
  -- An internal meeting or a time block names no customer and no service (as "Appointment_kind_shape").
  CONSTRAINT "AppointmentSeries_kind_shape" CHECK ("kind" = 'CUSTOMER' OR ("customerId" IS NULL AND "businessServiceId" IS NULL)),
  CONSTRAINT "AppointmentSeries_title_length" CHECK ("title" IS NULL OR char_length("title") <= 200),
  CONSTRAINT "AppointmentSeries_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "AppointmentSeries_id_businessId_key" ON "AppointmentSeries"("id", "businessId");
CREATE INDEX "AppointmentSeries_businessId_cancelledAt_idx" ON "AppointmentSeries"("businessId", "cancelledAt");
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_staffMemberId_tenant_fkey"
  FOREIGN KEY ("businessId", "staffMemberId") REFERENCES "StaffMember"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_businessServiceId_tenant_fkey"
  FOREIGN KEY ("businessServiceId", "businessId") REFERENCES "BusinessService"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "AppointmentSeries" ADD CONSTRAINT "AppointmentSeries_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TRIGGER "AppointmentSeries_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId" ON "AppointmentSeries"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_user_same_business('createdByUserId');

-- ── 3. Appointment — the occurrence's place in its series ───────────────────────────────────────────────────
ALTER TABLE "Appointment"
  ADD COLUMN "seriesId" INTEGER,
  ADD COLUMN "seriesIndex" INTEGER;
-- Both or neither; the index counts occurrences from 0.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_series_shape"
  CHECK (("seriesId" IS NULL) = ("seriesIndex" IS NULL) AND ("seriesIndex" IS NULL OR "seriesIndex" BETWEEN 0 AND 10000));
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_seriesId_tenant_fkey"
  FOREIGN KEY ("seriesId", "businessId") REFERENCES "AppointmentSeries"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
-- One occurrence per (series, index): a retried materialization can never double-book. Also serves the
-- (businessId, seriesId) lookups (its leading columns).
CREATE UNIQUE INDEX "Appointment_businessId_seriesId_seriesIndex_key"
  ON "Appointment"("businessId", "seriesId", "seriesIndex") WHERE "seriesId" IS NOT NULL;

-- ── 4. BookingSettings — self-service, reminders, horizon, logo (D4, G15, G16) ──────────────────────────────
ALTER TABLE "BookingSettings"
  ADD COLUMN "selfRescheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "selfRescheduleWindowHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "reminderOffsetsMinutes" INTEGER[] NOT NULL DEFAULT '{1440}',
  ADD COLUMN "bookingHorizonDays" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "showLogo" BOOLEAN NOT NULL DEFAULT false;
-- A month at most; 0 = until the start (as the self-cancel window).
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_self_reschedule_window"
  CHECK ("selfRescheduleWindowHours" BETWEEN 0 AND 720);
-- 0..3 reminders before the start, each 30 minutes .. 7 days; a flat list without NULLs ('{}' = no reminder).
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_reminder_offsets"
  CHECK (cardinality("reminderOffsetsMinutes") <= 3
     AND (cardinality("reminderOffsetsMinutes") = 0 OR array_ndims("reminderOffsetsMinutes") = 1)
     AND array_position("reminderOffsetsMinutes", NULL) IS NULL
     AND 30 <= ALL ("reminderOffsetsMinutes")
     AND 10080 >= ALL ("reminderOffsetsMinutes"));
ALTER TABLE "BookingSettings" ADD CONSTRAINT "BookingSettings_horizon"
  CHECK ("bookingHorizonDays" BETWEEN 1 AND 365);
-- NEW rows only: SET DEFAULT rewrites nothing; every existing row keeps its own value.
ALTER TABLE "BookingSettings" ALTER COLUMN "defaultApprovalMode" SET DEFAULT 'AUTO';
ALTER TABLE "BookingSettings" ALTER COLUMN "requireVerification" SET DEFAULT true;

-- ── 5. Phone verification (G2) ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE "BookingRequest" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- One one-time code sent to one phone for one business (owner requirement 3). Only keyed hashes (sha256 hex) are
-- stored: never the phone number, the code or the IP address.
--   * lifetime: 5 minutes by DEFAULT, 10 minutes at most (CHECK);
--   * single use: verified once, consumed once and only after verification — a trigger refuses every other change;
--   * a new code invalidates the previous ones: at most ONE open challenge per (business, phone) (partial unique index),
--     so issuing a new one requires superseding the open one in the same transaction (supersededAt), and a superseded,
--     expired or locked (5 wrong attempts) challenge can never be verified;
--   * send caps: per phone and per IP across ALL businesses through booking_otp_send_counts() (counts only), per
--     business through the tenant's own rows; the indexes below serve the three windows;
--   * retention: booking_phone_challenge_purge() deletes challenges older than the caller's cut-off, never younger than
--     24 hours (the cap window); the documented retention is 7 days. Account erasure clears the hashes in place.
CREATE TABLE "BookingPhoneChallenge" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "phoneHash" TEXT,
  "codeHash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sends" INTEGER NOT NULL DEFAULT 1,
  "ipHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '5 minutes'),
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "erasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingPhoneChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingPhoneChallenge_hashes" CHECK (
        ("erasedAt" IS NULL AND "phoneHash" IS NOT NULL AND "codeHash" IS NOT NULL
         AND "phoneHash" ~ '^[0-9a-f]{64}$' AND "codeHash" ~ '^[0-9a-f]{64}$'
         AND ("ipHash" IS NULL OR "ipHash" ~ '^[0-9a-f]{64}$'))
     OR ("erasedAt" IS NOT NULL AND "phoneHash" IS NULL AND "codeHash" IS NULL AND "ipHash" IS NULL)),
  CONSTRAINT "BookingPhoneChallenge_counters" CHECK ("attempts" BETWEEN 0 AND 5 AND "sends" BETWEEN 1 AND 3),
  CONSTRAINT "BookingPhoneChallenge_lifetime" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '10 minutes'),
  CONSTRAINT "BookingPhoneChallenge_consumed_after_verified" CHECK ("consumedAt" IS NULL OR "verifiedAt" IS NOT NULL),
  CONSTRAINT "BookingPhoneChallenge_superseded_unverified" CHECK ("supersededAt" IS NULL OR "verifiedAt" IS NULL)
);
-- The tenant's own lookups: one phone's recent challenges, and the business's send cap.
CREATE INDEX "BookingPhoneChallenge_businessId_phoneHash_createdAt_idx" ON "BookingPhoneChallenge"("businessId", "phoneHash", "createdAt");
CREATE INDEX "BookingPhoneChallenge_businessId_createdAt_idx" ON "BookingPhoneChallenge"("businessId", "createdAt");
-- The platform-wide caps (booking_otp_send_counts) and the retention sweep.
CREATE INDEX "BookingPhoneChallenge_phoneHash_createdAt_idx" ON "BookingPhoneChallenge"("phoneHash", "createdAt") WHERE "phoneHash" IS NOT NULL;
CREATE INDEX "BookingPhoneChallenge_ipHash_createdAt_idx" ON "BookingPhoneChallenge"("ipHash", "createdAt") WHERE "ipHash" IS NOT NULL;
CREATE INDEX "BookingPhoneChallenge_createdAt_idx" ON "BookingPhoneChallenge"("createdAt");
-- A new code invalidates the previous ones: one OPEN challenge per (business, phone).
CREATE UNIQUE INDEX "BookingPhoneChallenge_one_open_key" ON "BookingPhoneChallenge"("businessId", "phoneHash")
  WHERE "verifiedAt" IS NULL AND "supersededAt" IS NULL AND "erasedAt" IS NULL;
ALTER TABLE "BookingPhoneChallenge" ADD CONSTRAINT "BookingPhoneChallenge_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Single use, enforced by the database (for the runtime and the owner alike). Allowed changes only:
--   attempts / sends go up (never down); verifiedAt is set once, only while the challenge is live (not expired, not
--   superseded, fewer than 5 attempts); consumedAt is set once, after verification; supersededAt is set once, while
--   unverified; account erasure (all three hashes to NULL + erasedAt) at any time. Everything else is immutable.
CREATE OR REPLACE FUNCTION public.booking_phone_challenge_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_now timestamp(3) := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  erasing boolean := NEW."erasedAt" IS NOT NULL AND OLD."erasedAt" IS NULL;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR (NOT erasing AND (NEW."phoneHash" IS DISTINCT FROM OLD."phoneHash" OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
                          OR NEW."ipHash" IS DISTINCT FROM OLD."ipHash" OR NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt")) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = 'BOOKING_CHALLENGE_GUARD: identity, hashes and lifetime are immutable';
  END IF;
  IF NEW."attempts" < OLD."attempts" OR NEW."sends" < OLD."sends" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = 'BOOKING_CHALLENGE_GUARD: attempts and sends never go down';
  END IF;
  IF NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" THEN
    IF OLD."verifiedAt" IS NOT NULL OR OLD."supersededAt" IS NOT NULL OR OLD."erasedAt" IS NOT NULL
       OR OLD."expiresAt" <= v_now OR OLD."attempts" >= 5 THEN
      RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = 'BOOKING_CHALLENGE_GUARD: only a live challenge is verified, once';
    END IF;
  END IF;
  IF NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" AND OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = 'BOOKING_CHALLENGE_GUARD: a challenge is consumed once';
  END IF;
  IF NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" AND OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA05', MESSAGE = 'BOOKING_CHALLENGE_GUARD: a challenge is superseded once';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.booking_phone_challenge_guard() FROM PUBLIC;
CREATE TRIGGER "BookingPhoneChallenge_guard" BEFORE UPDATE ON "BookingPhoneChallenge"
  FOR EACH ROW EXECUTE FUNCTION public.booking_phone_challenge_guard();

-- ── 6. NotificationDelivery — customer WhatsApp through the engine (G1, G13) ────────────────────────────────
ALTER TABLE "NotificationDelivery"
  ADD COLUMN "recipientKind" TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN "recipientPhone" TEXT,
  ADD COLUMN "templateKey" TEXT,
  ADD COLUMN "messageClass" TEXT,
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "appointmentId" INTEGER;

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_recipient_kind"
  CHECK ("recipientKind" IN ('USER', 'CUSTOMER'));
-- A customer is reached on WhatsApp only, and WhatsApp reaches customers only (never a user's device). Compared as
-- text: the WHATSAPP label is new in this transaction and cannot be used as an enum value here.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_customer_channel"
  CHECK ((("recipientKind" = 'CUSTOMER') = ("channel"::text = 'WHATSAPP'))
     AND ("recipientKind" = 'USER' OR ("userId" IS NULL AND "subscriptionId" IS NULL)));
-- PRIVACY: a phone number only on a CUSTOMER delivery, in E.164. NULL on a CUSTOMER row = erased.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_recipient_phone"
  CHECK ("recipientPhone" IS NULL OR ("recipientKind" = 'CUSTOMER' AND "recipientPhone" ~ '^\+[1-9][0-9]{7,14}$'));
-- A customer message names its template and its class; a user delivery carries none of the WhatsApp columns.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_whatsapp_shape"
  CHECK (CASE WHEN "recipientKind" = 'CUSTOMER'
              THEN "templateKey" IS NOT NULL AND "messageClass" IS NOT NULL
              ELSE "templateKey" IS NULL AND "messageClass" IS NULL AND "providerMessageId" IS NULL
                   AND "providerStatus" IS NULL AND "providerUpdatedAt" IS NULL
         END);
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_whatsapp_tokens"
  CHECK (("templateKey" IS NULL OR "templateKey" ~ '^[a-z0-9_]{1,64}$')
     AND ("messageClass" IS NULL OR "messageClass" IN ('OPERATIONAL', 'VERIFICATION'))
     AND ("providerMessageId" IS NULL OR "providerMessageId" ~ '^[A-Za-z0-9_.:=+/-]{1,200}$')
     AND ("providerStatus" IS NULL OR "providerStatus" IN ('sent', 'delivered', 'read', 'failed')));
-- A provider status belongs to a provider message, and is stamped when it arrives.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_provider_status_shape"
  CHECK (("providerStatus" IS NULL) = ("providerUpdatedAt" IS NULL)
     AND ("providerStatus" IS NULL OR "providerMessageId" IS NOT NULL));
-- COMPOSITE, like every reference of this table: a delivery can never name another business's appointment.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_appointmentId_tenant_fkey"
  FOREIGN KEY ("appointmentId", "businessId") REFERENCES "Appointment"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ONE delivery row per logical customer message (owner requirements 5 and 7): a worker retry updates that row
-- (attempts, nextAttemptAt), it never adds one — so a retry can never send twice and metering counts each message once.
CREATE UNIQUE INDEX "NotificationDelivery_customer_one_per_notification_key" ON "NotificationDelivery"("notificationId")
  WHERE "recipientKind" = 'CUSTOMER';
-- Retention of the customer's phone (notification_customer_phone_purge).
CREATE INDEX "NotificationDelivery_customer_phone_retention_idx" ON "NotificationDelivery"("createdAt")
  WHERE "recipientPhone" IS NOT NULL;

-- Customer deliveries, enforced by the database (owner requirement 5). Allowed changes only:
--   * providerMessageId is written once and never changed (a sent message is never re-recorded as another);
--   * once a provider id exists the row never goes back to PENDING (a sent message is never sent again);
--   * the provider status only moves forward — sent → delivered → read; failed only from nothing or sent. A repeated
--     or out-of-order webhook (an older or equal status) is IGNORED: the row keeps its status and its time, and the
--     statement succeeds (idempotent);
--   * recipientKind, templateKey, messageClass, appointmentId and the phone are immutable, except the phone → NULL
--     (erasure / retention).
-- Push and in-app rows (USER) never reach the function (WHEN clause): their behaviour and cost are unchanged.
CREATE OR REPLACE FUNCTION public.notification_customer_delivery_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  old_rank integer := CASE OLD."providerStatus" WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END;
  new_rank integer := CASE NEW."providerStatus" WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END;
BEGIN
  IF NEW."recipientKind" IS DISTINCT FROM OLD."recipientKind" OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey"
     OR NEW."messageClass" IS DISTINCT FROM OLD."messageClass" OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."notificationId" IS DISTINCT FROM OLD."notificationId" OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR (NEW."recipientPhone" IS NOT NULL AND NEW."recipientPhone" IS DISTINCT FROM OLD."recipientPhone") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA06', MESSAGE = 'CUSTOMER_DELIVERY_GUARD: recipient, template, class and appointment are immutable';
  END IF;
  IF OLD."providerMessageId" IS NOT NULL AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA06', MESSAGE = 'CUSTOMER_DELIVERY_GUARD: the provider message id is written once';
  END IF;
  IF NEW."providerMessageId" IS NOT NULL AND NEW."status"::text = 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZA06', MESSAGE = 'CUSTOMER_DELIVERY_GUARD: a message handed to the provider is never owed again';
  END IF;
  IF new_rank IS DISTINCT FROM old_rank AND NOT (
       (old_rank = 0 AND new_rank > 0)
    OR (old_rank IN (1, 2) AND new_rank IN (2, 3) AND new_rank > old_rank)
    OR (old_rank = 1 AND new_rank = 4)) THEN
    -- An older, equal or contradicting status (a repeated / out-of-order webhook): keep what is recorded.
    NEW."providerStatus" := OLD."providerStatus";
    NEW."providerUpdatedAt" := OLD."providerUpdatedAt";
  ELSIF new_rank = old_rank THEN
    NEW."providerUpdatedAt" := OLD."providerUpdatedAt";
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.notification_customer_delivery_guard() FROM PUBLIC;
CREATE TRIGGER "NotificationDelivery_customer_guard" BEFORE UPDATE ON "NotificationDelivery"
  FOR EACH ROW WHEN (OLD."recipientKind" = 'CUSTOMER' OR NEW."recipientKind" = 'CUSTOMER')
  EXECUTE FUNCTION public.notification_customer_delivery_guard();

-- The WhatsApp lane's owed rows, in the worker's order (as "NotificationDelivery_push_owed_due_idx" for PUSH).
CREATE INDEX "NotificationDelivery_whatsapp_owed_idx" ON "NotificationDelivery"("nextAttemptAt" ASC NULLS FIRST, "id")
  WHERE "status" = 'PENDING' AND "recipientKind" = 'CUSTOMER';
-- The status webhook finds a delivery by the provider's id; one delivery per provider message.
CREATE UNIQUE INDEX "NotificationDelivery_providerMessageId_key" ON "NotificationDelivery"("providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;
-- An appointment moved or cancelled → its owed reminders are found and replaced / cancelled.
CREATE INDEX "NotificationDelivery_businessId_appointmentId_idx" ON "NotificationDelivery"("businessId", "appointmentId")
  WHERE "appointmentId" IS NOT NULL;
-- Usage metering: customer messages handed to the provider, per business per period (COUNT, no meter table).
CREATE INDEX "NotificationDelivery_customer_sent_idx" ON "NotificationDelivery"("businessId", "completedAt")
  WHERE "recipientKind" = 'CUSTOMER' AND "providerMessageId" IS NOT NULL;

-- ── 7. Definer doors: identifiers or counts only ────────────────────────────────────────────────
-- Owed customer messages that may be attempted now (due, not leased) in live businesses. The worker then reads,
-- claims and sends each one inside its own business's tenant transaction (as notification_push_due()).
CREATE OR REPLACE FUNCTION public.notification_whatsapp_due(p_now timestamp(3), p_limit integer)
RETURNS TABLE ("businessId" integer, "deliveryId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT d."businessId", d."id"
    FROM "NotificationDelivery" d
    JOIN "Business" b ON b."id" = d."businessId"
   WHERE d."status" = 'PENDING'
     AND d."recipientKind" = 'CUSTOMER'
     AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= p_now)
     AND (d."leaseUntil" IS NULL OR d."leaseUntil" < p_now)
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
   ORDER BY d."nextAttemptAt" NULLS FIRST, d."id"
   LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500)
$fn$;

-- The provider's status webhook carries only the provider's message id: exact match on the unique id, a well-formed
-- id only, live businesses only → the delivery's business and id. The update itself runs in that business's tenant
-- transaction. Never creates anything (no Conversation, no Message).
CREATE OR REPLACE FUNCTION public.notification_delivery_by_provider_message(p_provider_message_id text)
RETURNS TABLE ("businessId" integer, "deliveryId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT d."businessId", d."id"
    FROM "NotificationDelivery" d
    JOIN "Business" b ON b."id" = d."businessId"
   WHERE p_provider_message_id ~ '^[A-Za-z0-9_.:=+/-]{1,200}$'
     AND d."providerMessageId" = p_provider_message_id
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
   LIMIT 1
$fn$;

-- Platform-wide OTP send caps (owner requirement 3): how many codes were sent to this phone, and from this IP, across
-- ALL businesses since a moment no older than 24 hours. Counts only — never an id, a business or a hash. Malformed
-- input → zeros.
CREATE OR REPLACE FUNCTION public.booking_otp_send_counts(p_phone_hash text, p_ip_hash text, p_since timestamp(3))
RETURNS TABLE ("phoneSends" integer, "ipSends" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT
    coalesce((SELECT sum(c."sends")::integer FROM "BookingPhoneChallenge" c
               WHERE p_phone_hash ~ '^[0-9a-f]{64}$' AND c."phoneHash" = p_phone_hash
                 AND c."createdAt" >= GREATEST(p_since, (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '24 hours')), 0),
    coalesce((SELECT sum(c."sends")::integer FROM "BookingPhoneChallenge" c
               WHERE p_ip_hash ~ '^[0-9a-f]{64}$' AND c."ipHash" = p_ip_hash
                 AND c."createdAt" >= GREATEST(p_since, (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '24 hours')), 0)
$fn$;

-- Retention sweep of verification data (owner requirement 4): deletes challenges created before the cut-off — never
-- one younger than 24 hours (the cap window), whatever the caller passes. Documented retention: 7 days. Returns the
-- number removed; the runtime holds no DELETE on the table itself.
CREATE OR REPLACE FUNCTION public.booking_phone_challenge_purge(p_before timestamp(3), p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_cut timestamp(3) := LEAST(coalesce(p_before, '-infinity'), (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '24 hours');
  v_n integer;
BEGIN
  DELETE FROM "BookingPhoneChallenge" c
   WHERE c."id" IN (SELECT x."id" FROM "BookingPhoneChallenge" x WHERE x."createdAt" < v_cut
                     ORDER BY x."createdAt" LIMIT LEAST(GREATEST(coalesce(p_limit, 1000), 1), 5000));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- Retention of customers' phone numbers on deliveries (owner requirement 4): nulls recipientPhone on customer
-- deliveries created before the cut-off that are no longer owed (or whose time has passed) — never one younger than
-- 24 hours. Documented retention: 30 days. The row, its status and its provider id stay (metering, audit).
CREATE OR REPLACE FUNCTION public.notification_customer_phone_purge(p_before timestamp(3), p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_now timestamp(3) := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  v_cut timestamp(3) := LEAST(coalesce(p_before, '-infinity'), v_now - interval '24 hours');
  v_n integer;
BEGIN
  UPDATE "NotificationDelivery" d SET "recipientPhone" = NULL
   WHERE d."id" IN (SELECT x."id" FROM "NotificationDelivery" x
                     WHERE x."recipientPhone" IS NOT NULL AND x."createdAt" < v_cut
                       AND (x."status"::text <> 'PENDING' OR (x."expiresAt" IS NOT NULL AND x."expiresAt" < v_now))
                     ORDER BY x."createdAt" LIMIT LEAST(GREATEST(coalesce(p_limit, 1000), 1), 5000));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.booking_otp_send_counts(text, text, timestamp(3)) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.booking_phone_challenge_purge(timestamp(3), integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_customer_phone_purge(timestamp(3), integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_whatsapp_due(timestamp(3), integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_delivery_by_provider_message(text) FROM PUBLIC;

-- ── 8. Row-level security for the two new tables ────────────────────────────────────────────────────────────
ALTER TABLE "AppointmentSeries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentSeries" FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_series_tenant_select ON "AppointmentSeries" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY appointment_series_tenant_insert ON "AppointmentSeries" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY appointment_series_tenant_update ON "AppointmentSeries" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BookingPhoneChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingPhoneChallenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_phone_challenge_tenant_select ON "BookingPhoneChallenge" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_phone_challenge_tenant_insert ON "BookingPhoneChallenge" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY booking_phone_challenge_tenant_update ON "BookingPhoneChallenge" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 9. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "AppointmentSeries", "BookingPhoneChallenge" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "AppointmentSeries_id_seq", "BookingPhoneChallenge_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first (the Daily Tasks G4
-- finding). Existing tables are not in this list: their grants are left exactly as they are.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('AppointmentSeries', 'BookingPhoneChallenge', 'AppointmentSeries_id_seq', 'BookingPhoneChallenge_id_seq')
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

-- Read, add, change — never remove: a series is cancelled, a challenge is consumed or expires.
GRANT SELECT, INSERT, UPDATE ON "AppointmentSeries" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "AppointmentSeries_id_seq" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "BookingPhoneChallenge" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "BookingPhoneChallenge_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.notification_whatsapp_due(timestamp(3), integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.notification_delivery_by_provider_message(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.booking_otp_send_counts(text, text, timestamp(3)) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.booking_phone_challenge_purge(timestamp(3), integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.notification_customer_phone_purge(timestamp(3), integer) TO app_runtime;
