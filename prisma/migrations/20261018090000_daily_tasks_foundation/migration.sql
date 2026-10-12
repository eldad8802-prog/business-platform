-- Daily Tasks — data foundation (milestone A, migration only)
--
-- WHAT THIS ADDS
--   "Task" is EXTENDED, not replaced (owner decision D2, gate run 38287077419: the table is empty, FORCE RLS,
--   one FOR ALL policy p7w1_tenant whose USING / WITH CHECK equal wave 1 exactly). New columns are all
--   nullable or defaulted, so no existing row or battery fixture breaks: dueOn (a Jerusalem calendar day),
--   remindAt, closeReason, completedAt / completedByUserId, createdByUserId, assigneeUserId (unused in v1),
--   seriesId + sequence, pinnedAt, origin, version (optimistic lock), one optional entity link
--   (customerId | supplierId | leadId | documentId) and erasedAt. The legacy columns description (= the
--   owner's note), dueDate and sourceType stay untouched.
--
--   Five new tenant tables:
--     "TaskSeries"        — a recurrence rule; its occurrences are "Task" rows (seriesId, sequence);
--     "TaskSourceState"   — display state over business items, one row per treatment cycle
--                           (dedupeKey, cycleKey, evidenceVersion);
--     "TaskEvent"         — the append-only journal of owner actions and system observations;
--     "TaskPreferences"   — one row per business: disabled sources, morning summary, sync bookkeeping;
--     "TaskRequestLedger" — request fingerprints (HMAC) behind Idempotency-Key, operational, short-lived.
--   One non-tenant table, "TaskRetentionPolicy", read only by the retention functions.
--
-- G4 — THE OWNER'S DECISION ON "Task" PRIVILEGES
--   Production's gate run found privileges on "Task" and "Task_id_seq" that no migration granted (the
--   migration role's DEFAULT PRIVILEGES handed them out when core_data_layer_v1 created the table). Every
--   existing privilege on both is revoked — from every direct grantee, whoever it is — and then exactly
--   what the feature needs is granted to app_runtime: SELECT / INSERT / UPDATE on "Task", USAGE / SELECT on
--   its sequence. No DELETE, no TRUNCATE for anyone but the owner.
--
-- ISOLATION (FORCE RLS, per-command policies, no catch-all)
--   "Task"'s FOR ALL policy p7w1_tenant is replaced by SELECT / INSERT / UPDATE policies on the same GUC.
--   Every new tenant table: ENABLE + FORCE RLS, per-command policies on app.current_business_id, explicit
--   grants. No DELETE policy anywhere except "TaskRequestLedger" (account erasure removes a business's
--   fingerprints; registered in scripts/ci/account-deletion-guard.sh, CI-AD-13).
--   Cross-tenant references are refused by the database itself: composite (businessId, x) foreign keys for
--   series, events and entity links (ON DELETE SET NULL (col) for entities, PostgreSQL 15+), and a trigger
--   for user references ("User" has no (id, businessId) key; adding one would touch the auth table).
--   "Supplier" gains UNIQUE ("businessId", "id") — the only parent that lacked one (sec-C added Customer's
--   and Lead's; Document has its own).
--
-- APPEND-ONLY JOURNAL ("TaskEvent")
--   app_runtime holds SELECT / INSERT only. A trigger refuses every UPDATE and DELETE — for the owner too —
--   with three exceptions: a cascading DELETE (business deletion), the FK action ON DELETE SET NULL of
--   "actorUserId", and the retention functions below, which may only set identifying columns to NULL or
--   delete rows. TRUNCATE is refused by a statement trigger. "payload" is a closed shape: a JSON object
--   whose strings are short tokens ([A-Za-z0-9_:.-]{0,64}) — no free text can be stored, by construction.
--
-- RETENTION (planning; NOTHING IS SCHEDULED OR RUN BY THIS MIGRATION)
--   Five SECURITY DEFINER functions, owned by the migration role like every definer function in this
--   repository (it carries BYPASSRLS in Production), are the only path that changes history. They read
--   their periods from "TaskRetentionPolicy", take no date or range from the caller, and REFUSE to run while
--   their period is NULL. Only the two operational periods are seeded (7 days: request fingerprints and the
--   event digest — the idempotency mechanism, not history). The three history periods (H3: identifying
--   keys, learning events, source state) are NOT approved and are seeded NULL. The journal trigger lets a
--   change through only when it runs AS the table owner AND inside one of these functions (a
--   transaction-local marker the functions set); a session variable alone is not enough, because
--   app_runtime cannot become the owner. EXECUTE belongs to a new NOLOGIN role, task_maintenance, and to no
--   one else; no login exists for it until a separate owner decision.
--
-- FLAG
--   daily_tasks — PlatformFeatureDefinition + PlatformFeaturePolicy rows, OFF (defaultEnabled false,
--   globalEnabled false).
--
-- Additive: no existing column, row or index is changed or dropped, except the replaced "Task" policy and
-- the revoked "Task" privileges (both by owner decision). A rollback (.dt/rollback.sql) restores them.

-- ── 1. Enums ─────────────────────────────────────────────────────────────────────────────────────

CREATE TYPE "TaskOrigin" AS ENUM ('OWNER', 'SECRETARY', 'RECOMMENDATION');
CREATE TYPE "TaskCloseReason" AS ENUM ('SKIPPED', 'SERIES_CHANGED', 'WITHDRAWN_BY_REOPEN');
CREATE TYPE "TaskSeriesRuleKind" AS ENUM ('DAILY', 'WEEKDAYS', 'MONTH_DAY', 'EVERY_N_DAYS');
CREATE TYPE "TaskEventActor" AS ENUM ('OWNER_USER', 'SYSTEM');
CREATE TYPE "TaskEventType" AS ENUM (
  'TASK_CREATED', 'TASK_EDITED', 'TASK_RESCHEDULED', 'TASK_SNOOZED', 'TASK_COMPLETED', 'TASK_CANCELED',
  'TASK_REOPENED', 'OCCURRENCES_MISSED',
  'SERIES_CREATED', 'SERIES_CHANGED', 'SERIES_PAUSED', 'SERIES_RESUMED', 'SERIES_ENDED',
  'SOURCE_ITEM_ACKNOWLEDGED', 'SOURCE_ITEM_SNOOZED', 'SOURCE_ITEM_DISMISSED', 'SOURCE_ITEM_PINNED',
  'SOURCE_ITEM_UNPINNED', 'SOURCE_DISABLED', 'SOURCE_ENABLED', 'SOURCE_CLOSED_OBSERVED',
  'PREFERENCES_CHANGED'
);

-- ── 2. Supplier gets the tenant key every other link target already has ──────────────────────────

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessId_id_key" UNIQUE ("businessId", "id");

-- ── 3. TaskSeries ────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "TaskSeries" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "note" TEXT,
  "customerId" INTEGER,
  "supplierId" INTEGER,
  "leadId" INTEGER,
  "documentId" INTEGER,
  "ruleKind" "TaskSeriesRuleKind" NOT NULL,
  "ruleWeekdays" INTEGER[],
  "ruleMonthDay" INTEGER,
  "ruleIntervalDays" INTEGER,
  "startOn" DATE NOT NULL,
  "pausedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdByUserId" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "erasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskSeries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskSeries_one_link" CHECK (num_nonnulls("customerId", "supplierId", "leadId", "documentId") <= 1),
  CONSTRAINT "TaskSeries_version_positive" CHECK ("version" >= 1),
  -- Bounded, and empty allowed: account erasure blanks the text in place (title = '').
  CONSTRAINT "TaskSeries_title_length" CHECK (char_length("title") <= 200),
  CONSTRAINT "TaskSeries_note_length" CHECK ("note" IS NULL OR char_length("note") <= 2000),
  -- An empty weekday list counts as none (Prisma writes scalar lists as '{}', never NULL).
  CONSTRAINT "TaskSeries_rule_shape" CHECK (
       ("ruleKind" = 'DAILY'
         AND coalesce(cardinality("ruleWeekdays"), 0) = 0 AND "ruleMonthDay" IS NULL AND "ruleIntervalDays" IS NULL)
    OR ("ruleKind" = 'WEEKDAYS'
         AND cardinality("ruleWeekdays") BETWEEN 1 AND 7
         AND "ruleWeekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
         AND "ruleMonthDay" IS NULL AND "ruleIntervalDays" IS NULL)
    OR ("ruleKind" = 'MONTH_DAY'
         AND "ruleMonthDay" BETWEEN 1 AND 31
         AND coalesce(cardinality("ruleWeekdays"), 0) = 0 AND "ruleIntervalDays" IS NULL)
    OR ("ruleKind" = 'EVERY_N_DAYS'
         AND "ruleIntervalDays" BETWEEN 2 AND 366
         AND coalesce(cardinality("ruleWeekdays"), 0) = 0 AND "ruleMonthDay" IS NULL)
  )
);
CREATE UNIQUE INDEX "TaskSeries_businessId_id_key" ON "TaskSeries"("businessId", "id");

ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_supplierId_tenant_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id")
  ON DELETE SET NULL ("supplierId") ON UPDATE NO ACTION;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_documentId_tenant_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id")
  ON DELETE SET NULL ("documentId") ON UPDATE NO ACTION;

-- ── 4. Task — the extension ──────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"
  ADD COLUMN "dueOn" DATE,
  ADD COLUMN "remindAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" "TaskCloseReason",
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "completedByUserId" INTEGER,
  ADD COLUMN "createdByUserId" INTEGER,
  ADD COLUMN "assigneeUserId" INTEGER,
  ADD COLUMN "seriesId" INTEGER,
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "pinnedAt" TIMESTAMP(3),
  ADD COLUMN "origin" "TaskOrigin" NOT NULL DEFAULT 'OWNER',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "customerId" INTEGER,
  ADD COLUMN "supplierId" INTEGER,
  ADD COLUMN "leadId" INTEGER,
  ADD COLUMN "documentId" INTEGER,
  ADD COLUMN "erasedAt" TIMESTAMP(3);

ALTER TABLE "Task" ADD CONSTRAINT "Task_one_link"
  CHECK (num_nonnulls("customerId", "supplierId", "leadId", "documentId") <= 1);
ALTER TABLE "Task" ADD CONSTRAINT "Task_series_sequence_pair"
  CHECK (("seriesId" IS NULL) = ("sequence" IS NULL) AND ("sequence" IS NULL OR "sequence" >= 1));
ALTER TABLE "Task" ADD CONSTRAINT "Task_version_positive" CHECK ("version" >= 1);
-- Bounded, and empty allowed: account erasure blanks the text in place (title = '', description = NULL).
ALTER TABLE "Task" ADD CONSTRAINT "Task_text_length"
  CHECK (char_length("title") <= 200 AND ("description" IS NULL OR char_length("description") <= 2000));

CREATE UNIQUE INDEX "Task_businessId_id_key" ON "Task"("businessId", "id");
CREATE UNIQUE INDEX "Task_seriesId_sequence_key" ON "Task"("seriesId", "sequence");
-- D6: at most one OPEN occurrence per series — in the database, not only in code.
CREATE UNIQUE INDEX "Task_one_open_per_series" ON "Task"("seriesId") WHERE "status" = 'OPEN' AND "seriesId" IS NOT NULL;
CREATE INDEX "Task_businessId_status_dueOn_idx" ON "Task"("businessId", "status", "dueOn");

ALTER TABLE "Task" ADD CONSTRAINT "Task_seriesId_tenant_fkey"
  FOREIGN KEY ("businessId", "seriesId") REFERENCES "TaskSeries"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedByUserId_fkey"
  FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeUserId_fkey"
  FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION;
ALTER TABLE "Task" ADD CONSTRAINT "Task_supplierId_tenant_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id")
  ON DELETE SET NULL ("supplierId") ON UPDATE NO ACTION;
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION;
ALTER TABLE "Task" ADD CONSTRAINT "Task_documentId_tenant_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id")
  ON DELETE SET NULL ("documentId") ON UPDATE NO ACTION;

-- ── 5. TaskSourceState — one row per business item per treatment cycle ──────────────────────────

CREATE TABLE "TaskSourceState" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "cycleKey" TEXT NOT NULL,
  "evidenceVersion" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "closedObservedAt" TIMESTAMP(3),
  "snoozedUntil" TIMESTAMP(3),
  "acknowledgedOn" DATE,
  "ackEvidenceVersion" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "pinnedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskSourceState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskSourceState_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "TaskSourceState_tokens" CHECK (
        "sourceKind" ~ '^[a-z][a-z0-9_]{0,39}$'
    AND "dedupeKey" ~ '^[A-Za-z0-9:_.-]{1,200}$'
    AND "cycleKey" ~ '^[A-Za-z0-9:_.-]{1,200}$'
    AND "evidenceVersion" ~ '^[A-Za-z0-9:_.-]{1,200}$'
    AND ("ackEvidenceVersion" IS NULL OR "ackEvidenceVersion" ~ '^[A-Za-z0-9:_.-]{1,200}$')
  )
);
CREATE UNIQUE INDEX "TaskSourceState_businessId_dedupeKey_cycleKey_key"
  ON "TaskSourceState"("businessId", "dedupeKey", "cycleKey");
CREATE INDEX "TaskSourceState_closedObservedAt_idx" ON "TaskSourceState"("closedObservedAt");
ALTER TABLE "TaskSourceState" ADD CONSTRAINT "TaskSourceState_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. TaskEvent — the append-only journal ──────────────────────────────────────────────────────

CREATE TABLE "TaskEvent" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "taskId" INTEGER,
  "seriesId" INTEGER,
  "sourceKind" TEXT,
  "dedupeKey" TEXT,
  "cycleKey" TEXT,
  "eventType" "TaskEventType" NOT NULL,
  "actor" "TaskEventActor" NOT NULL,
  "actorUserId" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest" TEXT,
  "digestKeyId" TEXT,
  CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskEvent_system_has_no_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "TaskEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("sourceKind" IS NULL OR "sourceKind" ~ '^[a-z][a-z0-9_]{0,39}$')
    AND ("dedupeKey" IS NULL OR "dedupeKey" ~ '^[A-Za-z0-9:_.-]{1,200}$')
    AND ("cycleKey" IS NULL OR "cycleKey" ~ '^[A-Za-z0-9:_.-]{1,200}$')
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))
  ),
  -- A closed payload: an object of numbers, booleans, nulls, arrays and SHORT TOKENS — never free text.
  CONSTRAINT "TaskEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "TaskEvent_businessId_idempotencyKey_key" ON "TaskEvent"("businessId", "idempotencyKey");
CREATE INDEX "TaskEvent_businessId_taskId_idx" ON "TaskEvent"("businessId", "taskId");
CREATE INDEX "TaskEvent_businessId_seriesId_idx" ON "TaskEvent"("businessId", "seriesId");
CREATE INDEX "TaskEvent_businessId_occurredAt_idx" ON "TaskEvent"("businessId", "occurredAt");
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_tenant_fkey"
  FOREIGN KEY ("businessId", "taskId") REFERENCES "Task"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_seriesId_tenant_fkey"
  FOREIGN KEY ("businessId", "seriesId") REFERENCES "TaskSeries"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 7. TaskPreferences — one row per business ────────────────────────────────────────────────────

CREATE TABLE "TaskPreferences" (
  "businessId" INTEGER NOT NULL,
  "disabledSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "morningSummaryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "morningSummaryHour" INTEGER,
  "syncVersion" INTEGER NOT NULL DEFAULT 0,
  "syncLeaseUntil" TIMESTAMP(3),
  "lastSyncAt" TIMESTAMP(3),
  "lastSyncFailedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskPreferences_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "TaskPreferences_version_positive" CHECK ("version" >= 1 AND "syncVersion" >= 0),
  CONSTRAINT "TaskPreferences_hour" CHECK ("morningSummaryHour" IS NULL OR "morningSummaryHour" BETWEEN 0 AND 23),
  CONSTRAINT "TaskPreferences_sources_bounded" CHECK (cardinality("disabledSources") <= 64)
);
ALTER TABLE "TaskPreferences" ADD CONSTRAINT "TaskPreferences_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 8. TaskRequestLedger — request fingerprints (operational, 7 days) ────────────────────────────

CREATE TABLE "TaskRequestLedger" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "resultRef" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskRequestLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskRequestLedger_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9_-]{8,128}$'
    AND "requestDigest" ~ '^[0-9a-f]{64}$'
    AND "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$'
  ),
  CONSTRAINT "TaskRequestLedger_result_closed" CHECK (
        jsonb_typeof("resultRef") = 'object'
    AND octet_length("resultRef"::text) <= 1024
    AND NOT jsonb_path_exists("resultRef", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))')
  )
);
CREATE UNIQUE INDEX "TaskRequestLedger_businessId_idempotencyKey_key"
  ON "TaskRequestLedger"("businessId", "idempotencyKey");
CREATE INDEX "TaskRequestLedger_createdAt_idx" ON "TaskRequestLedger"("createdAt");
ALTER TABLE "TaskRequestLedger" ADD CONSTRAINT "TaskRequestLedger_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 9. User references stay inside the business (trigger; "User" has no tenant key) ─────────────

CREATE OR REPLACE FUNCTION public.task_user_same_business()
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
        ERRCODE = 'DZT03',
        MESSAGE = format('TASK_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.task_user_same_business() FROM PUBLIC;

CREATE TRIGGER "Task_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId", "completedByUserId", "assigneeUserId" ON "Task"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('createdByUserId', 'completedByUserId', 'assigneeUserId');
CREATE TRIGGER "TaskSeries_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId" ON "TaskSeries"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('createdByUserId');
CREATE TRIGGER "TaskEvent_user_same_business"
  BEFORE INSERT ON "TaskEvent"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('actorUserId');

-- ── 10. The journal guard ───────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.task_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  -- Inside a retention function: running AS the table owner AND with the transaction-local marker those
  -- functions set. app_runtime can set the marker but can never be the owner.
  in_retention boolean :=
        current_setting('dubiz.task_retention', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId', 'dedupeKey', 'cycleKey'];
  only_nulled boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR in_retention THEN
      RETURN OLD;  -- a cascade from Business, or the retention path
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    only_nulled :=
          (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
      AND (NEW."actorUserId"   IS NULL OR NEW."actorUserId"   IS NOT DISTINCT FROM OLD."actorUserId")
      AND (NEW."requestDigest" IS NULL OR NEW."requestDigest" IS NOT DISTINCT FROM OLD."requestDigest")
      AND (NEW."digestKeyId"   IS NULL OR NEW."digestKeyId"   IS NOT DISTINCT FROM OLD."digestKeyId")
      AND (NEW."dedupeKey"     IS NULL OR NEW."dedupeKey"     IS NOT DISTINCT FROM OLD."dedupeKey")
      AND (NEW."cycleKey"      IS NULL OR NEW."cycleKey"      IS NOT DISTINCT FROM OLD."cycleKey");
    IF only_nulled AND in_retention THEN
      RETURN NEW;
    END IF;
    -- The FK action of "actorUserId" (ON DELETE SET NULL): that column alone, to NULL.
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZT01',
    MESSAGE = format('TASK_EVENT_APPEND_ONLY: %s on %I is refused; the task journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.task_event_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.task_event_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'DZT01',
    MESSAGE = format('TASK_EVENT_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.task_event_truncate_guard() FROM PUBLIC;

CREATE TRIGGER "TaskEvent_append_only" BEFORE UPDATE OR DELETE ON "TaskEvent"
  FOR EACH ROW EXECUTE FUNCTION public.task_event_append_only_guard();
CREATE TRIGGER "TaskEvent_no_truncate" BEFORE TRUNCATE ON "TaskEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.task_event_truncate_guard();

-- ── 11. Retention policy (periods come from here only) ──────────────────────────────────────────

CREATE TABLE "TaskRetentionPolicy" (
  "kind" TEXT NOT NULL,
  "days" INTEGER,
  "basis" TEXT NOT NULL,
  CONSTRAINT "TaskRetentionPolicy_pkey" PRIMARY KEY ("kind"),
  CONSTRAINT "TaskRetentionPolicy_kind" CHECK ("kind" IN
    ('REQUEST_LEDGER', 'EVENT_DIGEST', 'SOURCE_IDENTIFIERS', 'LEARNING_EVENTS', 'SOURCE_STATE')),
  CONSTRAINT "TaskRetentionPolicy_days" CHECK ("days" IS NULL OR "days" BETWEEN 1 AND 3650),
  CONSTRAINT "TaskRetentionPolicy_basis" CHECK ("basis" IN ('OPERATIONAL', 'H3_PENDING', 'H3_APPROVED'))
);
-- Only the two operational periods. The three history periods await the owner's H3 decision: NULL, and the
-- functions refuse to run on a NULL period.
INSERT INTO "TaskRetentionPolicy" ("kind", "days", "basis") VALUES
  ('REQUEST_LEDGER', 7, 'OPERATIONAL'),
  ('EVENT_DIGEST', 7, 'OPERATIONAL'),
  ('SOURCE_IDENTIFIERS', NULL, 'H3_PENDING'),
  ('LEARNING_EVENTS', NULL, 'H3_PENDING'),
  ('SOURCE_STATE', NULL, 'H3_PENDING');

-- ── 12. Retention functions (EXIST only; nothing schedules or runs them) ─────────────────────────

CREATE OR REPLACE FUNCTION public.task_retention_days(p_kind text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_days integer;
BEGIN
  SELECT "days" INTO v_days FROM "TaskRetentionPolicy" WHERE "kind" = p_kind;
  IF v_days IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZT02',
      MESSAGE = format('TASK_RETENTION_NOT_APPROVED: no approved retention period for %s; nothing was changed', p_kind);
  END IF;
  RETURN v_days;
END
$fn$;

-- Operational: fingerprints older than REQUEST_LEDGER days, and every fingerprint of a deleted business.
CREATE OR REPLACE FUNCTION public.task_retention_purge_request_ledger()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_cutoff timestamp(3) := timezone('UTC', now()) - make_interval(days => public.task_retention_days('REQUEST_LEDGER'));
  v_n integer;
BEGIN
  DELETE FROM "TaskRequestLedger" l
   WHERE l."createdAt" < v_cutoff
      OR EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = l."businessId" AND b."deletedAt" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- Operational: the journal's second-line digest, after EVENT_DIGEST days, and at once for a deleted business.
CREATE OR REPLACE FUNCTION public.task_retention_clear_event_digests()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_cutoff timestamp(3) := timezone('UTC', now()) - make_interval(days => public.task_retention_days('EVENT_DIGEST'));
  v_n integer;
BEGIN
  PERFORM set_config('dubiz.task_retention', 'on', true);
  UPDATE "TaskEvent" e SET "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE e."requestDigest" IS NOT NULL
     AND (e."occurredAt" < v_cutoff
          OR EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = e."businessId" AND b."deletedAt" IS NOT NULL));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.task_retention', 'off', true);
  RETURN v_n;
END
$fn$;

-- H3 (not approved — refuses): identifying keys of business-item events, once their cycle has been closed
-- longer than SOURCE_IDENTIFIERS days. sourceKind, eventType and occurredAt stay for learning.
CREATE OR REPLACE FUNCTION public.task_retention_clear_source_identifiers()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_cutoff timestamp(3) := timezone('UTC', now()) - make_interval(days => public.task_retention_days('SOURCE_IDENTIFIERS'));
  v_n integer;
BEGIN
  PERFORM set_config('dubiz.task_retention', 'on', true);
  UPDATE "TaskEvent" e SET "dedupeKey" = NULL, "cycleKey" = NULL, "actorUserId" = NULL
   WHERE e."dedupeKey" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "TaskSourceState" s
                  WHERE s."businessId" = e."businessId" AND s."dedupeKey" = e."dedupeKey"
                    AND s."cycleKey" = e."cycleKey" AND s."closedObservedAt" < v_cutoff);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.task_retention', 'off', true);
  RETURN v_n;
END
$fn$;

-- H3 (not approved — refuses): business-item events older than LEARNING_EVENTS days. Events of the owner's
-- own tasks and series (taskId / seriesId set) are the owner's history and are never touched here.
CREATE OR REPLACE FUNCTION public.task_retention_purge_learning_events()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_cutoff timestamp(3) := timezone('UTC', now()) - make_interval(days => public.task_retention_days('LEARNING_EVENTS'));
  v_n integer;
BEGIN
  PERFORM set_config('dubiz.task_retention', 'on', true);
  DELETE FROM "TaskEvent" e
   WHERE e."taskId" IS NULL AND e."seriesId" IS NULL AND e."sourceKind" IS NOT NULL
     AND e."occurredAt" < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.task_retention', 'off', true);
  RETURN v_n;
END
$fn$;

-- H3 (not approved — refuses): source-state rows of cycles closed longer than SOURCE_STATE days. An open
-- cycle (closedObservedAt NULL) is never touched.
CREATE OR REPLACE FUNCTION public.task_retention_purge_source_state()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_cutoff timestamp(3) := timezone('UTC', now()) - make_interval(days => public.task_retention_days('SOURCE_STATE'));
  v_n integer;
BEGIN
  DELETE FROM "TaskSourceState" s WHERE s."closedObservedAt" IS NOT NULL AND s."closedObservedAt" < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- ── 13. Row-level security ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS p7w1_tenant ON "Task";
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_tenant_select ON "Task" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_tenant_insert ON "Task" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_tenant_update ON "Task" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskSeries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskSeries" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_series_tenant_select ON "TaskSeries" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_series_tenant_insert ON "TaskSeries" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_series_tenant_update ON "TaskSeries" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskSourceState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskSourceState" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_source_state_tenant_select ON "TaskSourceState" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_source_state_tenant_insert ON "TaskSourceState" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_source_state_tenant_update ON "TaskSourceState" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_event_tenant_select ON "TaskEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_event_tenant_insert ON "TaskEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskPreferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskPreferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_preferences_tenant_select ON "TaskPreferences" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_preferences_tenant_insert ON "TaskPreferences" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_preferences_tenant_update ON "TaskPreferences" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskRequestLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskRequestLedger" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_request_ledger_tenant_select ON "TaskRequestLedger" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_request_ledger_tenant_insert ON "TaskRequestLedger" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY task_request_ledger_runtime_delete ON "TaskRequestLedger" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "TaskRetentionPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskRetentionPolicy" FORCE ROW LEVEL SECURITY;

-- ── 14. Privileges — named explicitly ───────────────────────────────────────────────────────────

-- G4: every privilege on "Task" and its sequence, held by anyone but the owner, goes — then exactly what the
-- feature needs comes back to app_runtime (members such as app_runtime_prod inherit it).
DO $do$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT x.grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.oid IN ('public."Task"'::regclass, 'public."Task_id_seq"'::regclass)
       AND x.grantee <> c.relowner AND x.grantee <> 0
    UNION
    SELECT DISTINCT x.grantee
      FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE a.attrelid = 'public."Task"'::regclass AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public."Task" FROM %I', pg_get_userbyid(g.grantee));
    EXECUTE format('REVOKE ALL ON SEQUENCE public."Task_id_seq" FROM %I', pg_get_userbyid(g.grantee));
  END LOOP;
END
$do$;
REVOKE ALL ON "Task" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "Task_id_seq" FROM PUBLIC;

REVOKE ALL ON "TaskSeries", "TaskSourceState", "TaskEvent", "TaskPreferences", "TaskRequestLedger", "TaskRetentionPolicy" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "TaskSeries_id_seq", "TaskSourceState_id_seq", "TaskEvent_id_seq", "TaskRequestLedger_id_seq" FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "Task" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "Task_id_seq" TO app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "TaskSeries" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "TaskSeries_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TaskSeries" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "TaskSourceState" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "TaskSourceState_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TaskSourceState" FROM app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "TaskEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "TaskEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TaskEvent" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "TaskPreferences" TO app_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "TaskPreferences" FROM app_runtime;

    -- Fingerprints: written with the action, removed only by account erasure (and the retention path).
    GRANT SELECT, INSERT, DELETE ON "TaskRequestLedger" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "TaskRequestLedger_id_seq" TO app_runtime;
    REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "TaskRequestLedger" FROM app_runtime;

    REVOKE ALL ON "TaskRetentionPolicy" FROM app_runtime;
  END IF;
END
$do$;

-- The retention path: a NOLOGIN role that may EXECUTE the five functions and nothing else. No login exists.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'task_maintenance') THEN
    CREATE ROLE task_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$do$;

REVOKE ALL ON FUNCTION public.task_retention_days(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_retention_purge_request_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_retention_clear_event_digests() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_retention_clear_source_identifiers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_retention_purge_learning_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_retention_purge_source_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.task_retention_purge_request_ledger() TO task_maintenance;
GRANT EXECUTE ON FUNCTION public.task_retention_clear_event_digests() TO task_maintenance;
GRANT EXECUTE ON FUNCTION public.task_retention_clear_source_identifiers() TO task_maintenance;
GRANT EXECUTE ON FUNCTION public.task_retention_purge_learning_events() TO task_maintenance;
GRANT EXECUTE ON FUNCTION public.task_retention_purge_source_state() TO task_maintenance;

-- ── 15. The flag — OFF ─────────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('daily_tasks', 'היום שלי — משימות', 'tasks', 'מרכז המשימות היומי וסדר היום המשותף עם המזכירה — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('daily_tasks', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
