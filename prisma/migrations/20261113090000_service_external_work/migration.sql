-- ============================================================================================================
-- 20261113090000_service_external_work — Service Desk 1.2b: work at an external supplier (שליחה לספק חיצוני).
--
-- PR-1 of the migration-first rule: this migration and its PG17 lab only. No schema.prisma, no runtime code, no flag.
-- Expand-only: two NEW tables, four NEW enum types, their own functions, and two NEW invoker triggers on 1.2a tables
-- ("ServiceHandover", "ServiceCase") that only REFUSE — no existing column, policy, grant, row or function changes.
--
--   "ServiceExternalWork"       one row per send of a case to a supplier (round 1, 2, … per case); the item's stage at
--                               the supplier, the expected return date, supplier costs (estimated / approved / final),
--                               and the return (result, what was done, who received it). The current values only.
--   "ServiceExternalWorkEvent"  append-only journal of every change of a work: seq = the work's version after it.
--
-- Owner decisions ח‑1 … ח‑9 with three binding corrections (2026-11-05), mirroring the pure core 1.1d:
--   - supplier cost is documentation only (ע‑8 A): no commitment, expense, payment, charge or refund; a cancel never
--     clears it; it is unrelated to the customer's ServiceQuote;
--   - progress stages live on the work (never a case status): forward only, skipping allowed, information only;
--   - the final cost is recorded once; a mistake is corrected only by a COST_FINAL_CORRECTED event that keeps the
--     previous value, the new value, the reason and the acting user — never silently (correction 1);
--   - ONE open work per case and per DEVICE, race-safe: the device is copied from the case into the row and a partial
--     UNIQUE index refuses a second open work under any isolation level (correction 2);
--   - supplierReference is an RMA-like token by CHECK, and it is cleared on account erasure anyway (correction 3);
--   - no handover while a work is open (ח‑8); a case cannot leave EXTERNAL while its work is still at the supplier.
-- Every change of a work names its kind (lastEventKind); the guard checks the change IS that kind, the event must say
-- the same, and a deferred constraint trigger requires the event of every version at COMMIT — no silent change.
-- SECURITY DEFINER: one new function, service_external_erase_business(), search_path … pg_temp last. The existing
-- service_erase_business() is NOT changed. No DELETE for the runtime anywhere.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_EXTERNAL_WORK: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceHandover"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_EXTERNAL_WORK: the Service Desk foundation (20261112090000) is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Supplier_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'StaffMember_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key') THEN
    RAISE EXCEPTION 'SERVICE_EXTERNAL_WORK: a (businessId, id) key of Supplier / StaffMember / ServiceCase is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_EXTERNAL_WORK: the foundation trigger functions are missing; nothing was changed';
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceExternalWorkState" AS ENUM ('AT_SUPPLIER', 'RETURNED');
-- Declaration order IS the forward order (the guard compares them).
CREATE TYPE "ServiceExternalProgress" AS ENUM (
  'SENT', 'RECEIVED_BY_SUPPLIER', 'AWAITING_DIAGNOSIS', 'ESTIMATE_RECEIVED', 'IN_REPAIR_AT_SUPPLIER', 'REPAIR_DONE',
  'READY_FOR_PICKUP');
CREATE TYPE "ServiceExternalReturnResult" AS ENUM ('REPAIRED', 'NOT_REPAIRED', 'REPLACED_BY_SUPPLIER', 'RETURNED_UNWORKED');
CREATE TYPE "ServiceExternalWorkEventKind" AS ENUM (
  'SENT', 'PROGRESS', 'EXPECTED_BACK_CHANGED', 'COST_ESTIMATED', 'COST_APPROVED', 'COST_FINAL', 'COST_FINAL_CORRECTED',
  'RETURNED');

-- ── 2. ServiceExternalWork ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceExternalWork" (
  "id"                      SERIAL NOT NULL,
  "businessId"              INTEGER NOT NULL,
  "caseId"                  INTEGER NOT NULL,
  "round"                   INTEGER NOT NULL,
  "supplierId"              INTEGER NOT NULL,
  -- Copied from the case by the insert trigger (whatever the writer sent); fixed for the life of the row.
  "deviceId"                INTEGER,
  "state"                   "ServiceExternalWorkState" NOT NULL DEFAULT 'AT_SUPPLIER',
  "progressStage"           "ServiceExternalProgress" NOT NULL DEFAULT 'SENT',
  "lastEventKind"           "ServiceExternalWorkEventKind" NOT NULL DEFAULT 'SENT',
  "version"                 INTEGER NOT NULL DEFAULT 1,
  "sentAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentByUserId"            INTEGER,
  "sendReason"              TEXT,
  "requestedWork"           TEXT,
  "conditionAtSend"         TEXT,
  "operationalNote"         TEXT,
  "supplierReference"       TEXT,
  "expectedBackOn"          DATE,
  "estimatedCostAgorot"     INTEGER,
  "approvedCostAgorot"      INTEGER,
  "finalCostAgorot"         INTEGER,
  "currency"                TEXT NOT NULL DEFAULT 'ILS',
  "returnedAt"              TIMESTAMP(3),
  "returnedByUserId"        INTEGER,
  "returnResult"            "ServiceExternalReturnResult",
  "workPerformed"           TEXT,
  "unresolvedIssue"         TEXT,
  "followUpRequired"        BOOLEAN NOT NULL DEFAULT false,
  "receivedByStaffMemberId" INTEGER,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"                TIMESTAMP(3),
  CONSTRAINT "ServiceExternalWork_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceExternalWork_numbers" CHECK ("round" >= 1 AND "version" >= 1),
  CONSTRAINT "ServiceExternalWork_costs" CHECK (
        ("estimatedCostAgorot" IS NULL OR "estimatedCostAgorot" >= 0)
    AND ("approvedCostAgorot" IS NULL OR "approvedCostAgorot" >= 0)
    AND ("finalCostAgorot" IS NULL OR "finalCostAgorot" >= 0)
    AND "currency" = 'ILS'),
  -- At the supplier ⇔ not returned; the return's own columns exist only after the return.
  CONSTRAINT "ServiceExternalWork_return" CHECK (
        ("state" = 'AT_SUPPLIER') = ("returnedAt" IS NULL)
    AND ("state" = 'AT_SUPPLIER') = ("returnResult" IS NULL)
    AND ("state" = 'RETURNED' OR ("workPerformed" IS NULL AND "unresolvedIssue" IS NULL AND "returnedByUserId" IS NULL
                                  AND "receivedByStaffMemberId" IS NULL AND NOT "followUpRequired"))),
  -- Correction 3: an RMA-like token — no spaces, no '@', no letters outside A–Z — at most 40.
  CONSTRAINT "ServiceExternalWork_supplier_reference" CHECK (
    "supplierReference" IS NULL OR "supplierReference" ~ '^[A-Za-z0-9][A-Za-z0-9._/#-]{0,39}$'),
  CONSTRAINT "ServiceExternalWork_texts" CHECK (
        ("sendReason" IS NOT NULL OR "erasedAt" IS NOT NULL)
    AND ("sendReason" IS NULL OR (char_length("sendReason") <= 1000 AND btrim("sendReason") <> '' AND "sendReason" = btrim("sendReason")))
    AND ("requestedWork" IS NULL OR (char_length("requestedWork") <= 2000 AND btrim("requestedWork") <> '' AND "requestedWork" = btrim("requestedWork")))
    AND ("conditionAtSend" IS NULL OR (char_length("conditionAtSend") <= 2000 AND btrim("conditionAtSend") <> '' AND "conditionAtSend" = btrim("conditionAtSend")))
    AND ("operationalNote" IS NULL OR (char_length("operationalNote") <= 2000 AND btrim("operationalNote") <> '' AND "operationalNote" = btrim("operationalNote")))
    AND ("workPerformed" IS NULL OR (char_length("workPerformed") <= 2000 AND btrim("workPerformed") <> '' AND "workPerformed" = btrim("workPerformed")))
    AND ("unresolvedIssue" IS NULL OR (char_length("unresolvedIssue") <= 2000 AND btrim("unresolvedIssue") <> '' AND "unresolvedIssue" = btrim("unresolvedIssue"))))
);
CREATE UNIQUE INDEX "ServiceExternalWork_businessId_id_key" ON "ServiceExternalWork"("businessId", "id");
CREATE UNIQUE INDEX "ServiceExternalWork_businessId_caseId_round_key" ON "ServiceExternalWork"("businessId", "caseId", "round");
-- One open work per case, and per device across cases — enforced by the index itself (race-safe at any isolation).
CREATE UNIQUE INDEX "ServiceExternalWork_one_open_per_case" ON "ServiceExternalWork"("businessId", "caseId")
  WHERE "state" = 'AT_SUPPLIER';
CREATE UNIQUE INDEX "ServiceExternalWork_one_open_per_device" ON "ServiceExternalWork"("businessId", "deviceId")
  WHERE "state" = 'AT_SUPPLIER' AND "deviceId" IS NOT NULL;
CREATE INDEX "ServiceExternalWork_businessId_supplierId_idx" ON "ServiceExternalWork"("businessId", "supplierId");
CREATE INDEX "ServiceExternalWork_businessId_state_idx" ON "ServiceExternalWork"("businessId", "state");
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_supplier_tenant_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_device_tenant_fkey"
  FOREIGN KEY ("businessId", "deviceId") REFERENCES "ServiceDevice"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_staff_tenant_fkey"
  FOREIGN KEY ("businessId", "receivedByStaffMemberId") REFERENCES "StaffMember"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_sentByUserId_fkey"
  FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceExternalWork" ADD CONSTRAINT "ServiceExternalWork_returnedByUserId_fkey"
  FOREIGN KEY ("returnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. ServiceExternalWorkEvent — the append-only journal of a work ─────────────────────────────────────────
CREATE TABLE "ServiceExternalWorkEvent" (
  "id"                   SERIAL NOT NULL,
  "businessId"           INTEGER NOT NULL,
  "workId"               INTEGER NOT NULL,
  "caseId"               INTEGER NOT NULL,
  "seq"                  INTEGER NOT NULL,
  "kind"                 "ServiceExternalWorkEventKind" NOT NULL,
  "progressStage"        "ServiceExternalProgress" NOT NULL,
  "amountAgorot"         INTEGER,
  "previousAmountAgorot" INTEGER,
  "expectedBackOn"       DATE,
  -- Only the correction carries a reason (a business column, cleared on account erasure — never in the payload).
  "reason"               TEXT,
  "actor"                "ServiceActor" NOT NULL,
  "actorUserId"          INTEGER,
  "occurredAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload"              JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey"       TEXT NOT NULL,
  "requestDigest"        TEXT,
  "digestKeyId"          TEXT,
  "erasedAt"             TIMESTAMP(3),
  CONSTRAINT "ServiceExternalWorkEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceExternalWorkEvent_seq" CHECK ("seq" >= 1 AND ("seq" = 1) = ("kind" = 'SENT')),
  CONSTRAINT "ServiceExternalWorkEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "ServiceExternalWorkEvent_amounts" CHECK (
        ("amountAgorot" IS NULL OR "amountAgorot" >= 0)
    AND ("previousAmountAgorot" IS NULL OR "previousAmountAgorot" >= 0)
    AND ("kind" NOT IN ('COST_ESTIMATED', 'COST_APPROVED', 'COST_FINAL', 'COST_FINAL_CORRECTED') OR "amountAgorot" IS NOT NULL)
    AND ("kind" <> 'COST_FINAL_CORRECTED' OR ("previousAmountAgorot" IS NOT NULL AND "previousAmountAgorot" <> "amountAgorot"))),
  -- Correction 1: the correction keeps its reason (until the account erasure blanks it, stamping erasedAt).
  CONSTRAINT "ServiceExternalWorkEvent_reason" CHECK (
        ("reason" IS NULL OR ("kind" = 'COST_FINAL_CORRECTED' AND char_length("reason") <= 1000 AND btrim("reason") <> '' AND "reason" = btrim("reason")))
    AND ("kind" <> 'COST_FINAL_CORRECTED' OR "reason" IS NOT NULL OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "ServiceExternalWorkEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))),
  CONSTRAINT "ServiceExternalWorkEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))'))
);
CREATE UNIQUE INDEX "ServiceExternalWorkEvent_businessId_workId_seq_key" ON "ServiceExternalWorkEvent"("businessId", "workId", "seq");
CREATE UNIQUE INDEX "ServiceExternalWorkEvent_businessId_idempotencyKey_key" ON "ServiceExternalWorkEvent"("businessId", "idempotencyKey");
CREATE INDEX "ServiceExternalWorkEvent_businessId_occurredAt_idx" ON "ServiceExternalWorkEvent"("businessId", "occurredAt");
ALTER TABLE "ServiceExternalWorkEvent" ADD CONSTRAINT "ServiceExternalWorkEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceExternalWorkEvent" ADD CONSTRAINT "ServiceExternalWorkEvent_work_tenant_fkey"
  FOREIGN KEY ("businessId", "workId") REFERENCES "ServiceExternalWork"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWorkEvent" ADD CONSTRAINT "ServiceExternalWorkEvent_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceExternalWorkEvent" ADD CONSTRAINT "ServiceExternalWorkEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- Acting users of the same business (the foundation's invoker function, reused unchanged).
CREATE TRIGGER "ServiceExternalWork_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "sentByUserId", "returnedByUserId" ON "ServiceExternalWork"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('sentByUserId', 'returnedByUserId');
CREATE TRIGGER "ServiceExternalWorkEvent_user_same_business"
  BEFORE INSERT ON "ServiceExternalWorkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- 4.1 INSERT: a send opens the next round of a case that is EXTERNAL now, at its initial state. The case row is
-- locked first (the same lock the handover guard takes), so a send and a handover of one case serialise; the device
-- is copied from the case, so the per-device UNIQUE index decides a race between two cases of one device.
CREATE OR REPLACE FUNCTION public.service_external_work_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  last_round integer;
BEGIN
  SELECT "status", "deviceId" INTO c FROM "ServiceCase"
   WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX01', MESSAGE = 'SERVICE_EXTERNAL_CASE_INVALID: the work must name a case of the same business';
  END IF;
  IF c."status" <> 'EXTERNAL' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX01', MESSAGE = format('SERVICE_EXTERNAL_CASE_NOT_EXTERNAL: the case is %s; a send moves it to EXTERNAL first, in the same transaction', c."status");
  END IF;
  NEW."deviceId" := c."deviceId";
  SELECT COALESCE(max("round"), 0) INTO last_round FROM "ServiceExternalWork"
   WHERE "businessId" = NEW."businessId" AND "caseId" = NEW."caseId";
  IF NEW."round" <> last_round + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX01', MESSAGE = format('SERVICE_EXTERNAL_ROUND_NOT_NEXT: round %s, expected %s', NEW."round", last_round + 1);
  END IF;
  IF NEW."state" <> 'AT_SUPPLIER' OR NEW."progressStage" <> 'SENT' OR NEW."lastEventKind" <> 'SENT' OR NEW."version" <> 1
     OR NEW."estimatedCostAgorot" IS NOT NULL OR NEW."approvedCostAgorot" IS NOT NULL OR NEW."finalCostAgorot" IS NOT NULL
     OR NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX01', MESSAGE = 'SERVICE_EXTERNAL_NOT_INITIAL: a send opens AT_SUPPLIER / SENT / version 1, with no cost yet';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_work_insert_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceExternalWork_insert_guard" BEFORE INSERT ON "ServiceExternalWork"
  FOR EACH ROW EXECUTE FUNCTION public.service_external_work_insert_guard();

-- 4.2 UPDATE: every change is ONE named kind (lastEventKind) that bumps the version by one, and changes exactly what
-- that kind may change. Only the account erasure (owner + marker) may blank text and users without a version bump;
-- the FK action of a deleted user may null a user id.
CREATE OR REPLACE FUNCTION public.service_external_work_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['sendReason', 'requestedWork', 'conditionAtSend', 'operationalNote', 'supplierReference',
                                    'workPerformed', 'unresolvedIssue', 'sentByUserId', 'returnedByUserId', 'erasedAt'];
  bookkeeping constant text[] := ARRAY['version', 'lastEventKind', 'updatedAt'];
  allowed text[];
  k "ServiceExternalWorkEventKind" := NEW."lastEventKind";
BEGIN
  IF in_erasure
     AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
     AND NEW."sendReason" IS NULL AND NEW."requestedWork" IS NULL AND NEW."conditionAtSend" IS NULL
     AND NEW."operationalNote" IS NULL AND NEW."supplierReference" IS NULL AND NEW."workPerformed" IS NULL
     AND NEW."unresolvedIssue" IS NULL AND NEW."sentByUserId" IS NULL AND NEW."returnedByUserId" IS NULL
     AND NEW."erasedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - ARRAY['sentByUserId', 'returnedByUserId']) = (to_jsonb(OLD) - ARRAY['sentByUserId', 'returnedByUserId'])
     AND (NEW."sentByUserId" IS NULL OR NEW."sentByUserId" = OLD."sentByUserId")
     AND (NEW."returnedByUserId" IS NULL OR NEW."returnedByUserId" = OLD."returnedByUserId") THEN
    RETURN NEW;
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = format('SERVICE_EXTERNAL_VERSION: a change moves the version from %s to %s, not %s', OLD."version", OLD."version" + 1, NEW."version");
  END IF;
  allowed := CASE k
    WHEN 'PROGRESS' THEN ARRAY['progressStage', 'supplierReference']
    WHEN 'EXPECTED_BACK_CHANGED' THEN ARRAY['expectedBackOn']
    WHEN 'COST_ESTIMATED' THEN ARRAY['estimatedCostAgorot']
    WHEN 'COST_APPROVED' THEN ARRAY['approvedCostAgorot']
    WHEN 'COST_FINAL' THEN ARRAY['finalCostAgorot']
    WHEN 'COST_FINAL_CORRECTED' THEN ARRAY['finalCostAgorot']
    WHEN 'RETURNED' THEN ARRAY['state', 'returnedAt', 'returnedByUserId', 'returnResult', 'workPerformed', 'unresolvedIssue',
                               'followUpRequired', 'receivedByStaffMemberId', 'finalCostAgorot']
    ELSE NULL END;
  IF allowed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = format('SERVICE_EXTERNAL_KIND: %s is not a change of an existing work', k);
  END IF;
  IF (to_jsonb(NEW) - allowed - bookkeeping) <> (to_jsonb(OLD) - allowed - bookkeeping) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = format('SERVICE_EXTERNAL_CHANGE_NOT_KIND: a %s changes only its own columns', k);
  END IF;
  IF k IN ('PROGRESS', 'EXPECTED_BACK_CHANGED', 'COST_ESTIMATED', 'COST_APPROVED', 'RETURNED') AND OLD."state" <> 'AT_SUPPLIER' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = format('SERVICE_EXTERNAL_RETURNED: a %s needs the item at the supplier', k);
  END IF;
  IF k = 'PROGRESS' AND NOT (NEW."progressStage" > OLD."progressStage"
       AND (NEW."supplierReference" IS NOT DISTINCT FROM OLD."supplierReference" OR OLD."supplierReference" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = 'SERVICE_EXTERNAL_PROGRESS: progress moves forward only; the supplier reference is set once';
  END IF;
  IF (k = 'EXPECTED_BACK_CHANGED' AND NEW."expectedBackOn" IS NOT DISTINCT FROM OLD."expectedBackOn")
     OR (k = 'COST_ESTIMATED' AND (NEW."estimatedCostAgorot" IS NULL))
     OR (k = 'COST_APPROVED' AND (NEW."approvedCostAgorot" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = format('SERVICE_EXTERNAL_NO_CHANGE: a %s must set its value', k);
  END IF;
  IF k = 'COST_FINAL' AND NOT (OLD."finalCostAgorot" IS NULL AND NEW."finalCostAgorot" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = 'SERVICE_EXTERNAL_FINAL_ONCE: the final cost is recorded once; a mistake is a COST_FINAL_CORRECTED';
  END IF;
  IF k = 'COST_FINAL_CORRECTED' AND NOT (OLD."finalCostAgorot" IS NOT NULL AND NEW."finalCostAgorot" IS NOT NULL
                                         AND NEW."finalCostAgorot" <> OLD."finalCostAgorot") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = 'SERVICE_EXTERNAL_CORRECTION: a correction changes a recorded final cost';
  END IF;
  IF k = 'RETURNED' AND NOT (NEW."state" = 'RETURNED'
       AND (OLD."finalCostAgorot" IS NULL OR NEW."finalCostAgorot" IS NOT DISTINCT FROM OLD."finalCostAgorot")) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX02', MESSAGE = 'SERVICE_EXTERNAL_RETURN: a return closes the work and may record, not change, the final cost';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_work_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceExternalWork_guard" BEFORE UPDATE ON "ServiceExternalWork"
  FOR EACH ROW EXECUTE FUNCTION public.service_external_work_guard();

-- 4.3 No silent change: at COMMIT the work's current version has its event (any erasure keeps the version).
CREATE OR REPLACE FUNCTION public.service_external_work_has_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  w record;
BEGIN
  SELECT "version", "lastEventKind" INTO w FROM "ServiceExternalWork" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ServiceExternalWorkEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."workId" = NEW."id" AND e."seq" = w."version" AND e."kind" = w."lastEventKind") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZX03',
      MESSAGE = format('SERVICE_EXTERNAL_SILENT_CHANGE: work %s is at version %s (%s) with no journal event for it', NEW."id", w."version", w."lastEventKind");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_work_has_event() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceExternalWork_has_event" AFTER INSERT OR UPDATE ON "ServiceExternalWork"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_external_work_has_event();

-- 4.4 The event mirrors the work as this transaction just left it: same case, seq = version, kind = lastEventKind,
-- stage and expected date as on the row, and the amount of a cost kind = the column it changed.
CREATE OR REPLACE FUNCTION public.service_external_event_matches_work()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  w record;
BEGIN
  SELECT * INTO w FROM "ServiceExternalWork" WHERE "id" = NEW."workId" AND "businessId" = NEW."businessId";
  IF NOT FOUND OR w."caseId" <> NEW."caseId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX04', MESSAGE = 'SERVICE_EXTERNAL_EVENT_WORK_INVALID: the event must name a work (and its case) of the same business';
  END IF;
  IF NEW."seq" <> w."version" OR NEW."kind" <> w."lastEventKind" OR NEW."progressStage" <> w."progressStage"
     OR NEW."expectedBackOn" IS DISTINCT FROM w."expectedBackOn"
     OR (NEW."kind" = 'COST_ESTIMATED' AND NEW."amountAgorot" IS DISTINCT FROM w."estimatedCostAgorot")
     OR (NEW."kind" = 'COST_APPROVED' AND NEW."amountAgorot" IS DISTINCT FROM w."approvedCostAgorot")
     OR (NEW."kind" IN ('COST_FINAL', 'COST_FINAL_CORRECTED') AND NEW."amountAgorot" IS DISTINCT FROM w."finalCostAgorot")
     OR (NEW."kind" = 'RETURNED' AND (w."state" <> 'RETURNED' OR (NEW."amountAgorot" IS NOT NULL AND NEW."amountAgorot" IS DISTINCT FROM w."finalCostAgorot")))
     OR (NEW."kind" <> 'RETURNED' AND NEW."kind"::text NOT LIKE 'COST%' AND NEW."amountAgorot" IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZX04',
      MESSAGE = format('SERVICE_EXTERNAL_EVENT_MISMATCH: event %s seq %s must mirror work version %s (%s)', NEW."kind", NEW."seq", w."version", w."lastEventKind");
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_event_matches_work() FROM PUBLIC;
CREATE TRIGGER "ServiceExternalWorkEvent_matches_work" BEFORE INSERT ON "ServiceExternalWorkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_external_event_matches_work();

-- 4.5 The journal is append-only: no UPDATE but the erasure's scrub (users, digests, the correction reason) and the
-- FK action of a deleted user; no DELETE but the cascade of a deleted business; no TRUNCATE.
CREATE OR REPLACE FUNCTION public.service_external_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId', 'reason', 'erasedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL AND NEW."reason" IS NULL
       AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZX05',
    MESSAGE = format('SERVICE_EXTERNAL_EVENT_APPEND_ONLY: %s on %I is refused; the journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceExternalWorkEvent_append_only" BEFORE UPDATE OR DELETE ON "ServiceExternalWorkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_external_event_guard();
CREATE TRIGGER "ServiceExternalWorkEvent_no_truncate" BEFORE TRUNCATE ON "ServiceExternalWorkEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.6 ח‑8: no handover of a case whose item is still at a supplier. The case row is locked first — the lock a send
-- takes — so a handover and a send of one case cannot both pass.
CREATE OR REPLACE FUNCTION public.service_handover_no_open_external()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM "ServiceCase" WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ServiceExternalWork" w
              WHERE w."businessId" = NEW."businessId" AND w."caseId" = NEW."caseId" AND w."state" = 'AT_SUPPLIER') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX06', MESSAGE = 'SERVICE_HANDOVER_AT_SUPPLIER: the item is still at a supplier; record its return first';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_no_open_external() FROM PUBLIC;
CREATE TRIGGER "ServiceHandover_no_open_external" BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_handover_no_open_external();

-- 4.7 A case cannot leave EXTERNAL while its work is still at the supplier (checked at COMMIT, so the return may
-- update the case and then close the work in either order inside one transaction).
CREATE OR REPLACE FUNCTION public.service_case_external_work_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  s "ServiceCaseStatus";
BEGIN
  SELECT "status" INTO s FROM "ServiceCase" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF FOUND AND s <> 'EXTERNAL' AND EXISTS (SELECT 1 FROM "ServiceExternalWork" w
       WHERE w."businessId" = NEW."businessId" AND w."caseId" = NEW."id" AND w."state" = 'AT_SUPPLIER') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX07', MESSAGE = format('SERVICE_CASE_LEFT_EXTERNAL: case %s is %s but its work is still at the supplier', NEW."id", s);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_external_work_closed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_external_work_closed" AFTER UPDATE OF "status" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_external_work_closed();

-- ── 5. Account erasure: the one SECURITY DEFINER function ───────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZX08, nothing changed) without a context or
-- when that business is not being deleted. Otherwise blanks, for that business only: the work's six free texts and the
-- supplier reference (correction 3), the acting users, and in the journal the acting users, request digests and
-- correction reasons; stamps erasedAt. Supplier, amounts, dates, stages and results stay. Returns rows touched.
-- The account-deletion flow calls it in its purge transaction (wired with the Prisma PR).
CREATE OR REPLACE FUNCTION public.service_external_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX08', MESSAGE = 'SERVICE_EXTERNAL_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZX08', MESSAGE = 'SERVICE_EXTERNAL_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_erasure', 'on', true);

  UPDATE public."ServiceExternalWork" SET "sendReason" = NULL, "requestedWork" = NULL, "conditionAtSend" = NULL,
         "operationalNote" = NULL, "supplierReference" = NULL, "workPerformed" = NULL, "unresolvedIssue" = NULL,
         "sentByUserId" = NULL, "returnedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceExternalWorkEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL,
         "reason" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_erase_business() FROM PUBLIC;

-- ── 6. Row-level security — per operation, no DELETE policy ─────────────────────────────────────────────────
ALTER TABLE "ServiceExternalWork" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceExternalWork" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_external_work_tenant_select ON "ServiceExternalWork" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_external_work_tenant_insert ON "ServiceExternalWork" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_external_work_tenant_update ON "ServiceExternalWork" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceExternalWorkEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceExternalWorkEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_external_event_tenant_select ON "ServiceExternalWorkEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_external_event_tenant_insert ON "ServiceExternalWorkEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceExternalWork", "ServiceExternalWorkEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceExternalWork_id_seq", "ServiceExternalWorkEvent_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceExternalWork', 'ServiceExternalWorkEvent', 'ServiceExternalWork_id_seq', 'ServiceExternalWorkEvent_id_seq')
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
GRANT SELECT, INSERT, UPDATE ON "ServiceExternalWork" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceExternalWork_id_seq" TO app_runtime;
GRANT SELECT, INSERT ON "ServiceExternalWorkEvent" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceExternalWorkEvent_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_external_erase_business() TO app_runtime;
