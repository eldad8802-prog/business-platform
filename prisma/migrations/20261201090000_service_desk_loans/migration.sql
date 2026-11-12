-- ============================================================================================================
-- 20261201090000_service_desk_loans — Service Desk: a temporary replacement item lent to the customer during service
-- ("פריט חלופי" / loaner) — for ANY business that lends something while it serves (a phone, a car, a tool, a router, a
-- heater …), not only a lab. DRAFT — never applied without the owner's separate approval.
-- Order: after 20261130090000_service_handover_debt_record (#1128): the handover's loaner columns (loanerOverrideReason,
-- loanerApprovedByUserId, loanerApprovedAt) are a premise. Independent of 20261128090000 (parts reservation guard),
-- 20261129090000 (QA lists) and 20261130100000 (QA track defaults): none of them names an object created or read here,
-- and this migration REPLACES NO EXISTING FUNCTION (it adds its own functions and triggers only).
--
-- Owner requirements (2026-11-12, binding):
--   - the loan is its own record: business + case, the lent item (free-text name, an optional serial / identifier, an
--     optional READ-ONLY reference to an inventory item), when and by whom it was lent, the expected return (optional),
--     the actual return and by whom, the item's condition at lending and at return, its state, an append-only journal,
--     and a reason + approval wherever an exception is needed;
--   - INVENTORY: the reference to InventoryItem is read-only (composite tenant FK, like ServicePart). NO stock movement is
--     written or implied: the inventory movement contract (M0) is not ready and the 'SERVICE_PART' reason is lab-only.
--     Lending an inventory item does not move its quantity — that is a later, separate decision;
--   - never two open loans of the same identified item: a partial UNIQUE index on (businessId, normalized identifier)
--     WHERE the loan is OUT — race-safe at any isolation level;
--   - lent only while the case is being worked on; never on a cancelled / closed case (the statuses are below);
--   - returned at any time — also after the repaired item was delivered, or the case closed / cancelled — once; a return
--     never changes history and the loan record is never deleted;
--   - DELIVER while a loan is OUT needs the owner's approval with a reason (ServiceHandover loaner columns, #1128); and
--     with NO loan out the handover carries no loaner approval / reason at all (refused at INSERT; rows saved before
--     this migration are not re-judged);
--   - CANCEL / ABANDON while a loan is OUT needs an approval with a reason, recorded ON THE LOAN (a CASE_EXIT_APPROVED
--     journal event bound to the case event it approves); the loan stays OUT — a cancel never releases or deletes it;
--   - a loan that will not come back is closed only by an explicit, approved action with a reason (LOST /
--     KEPT_BY_CUSTOMER / WRITTEN_OFF); a case cannot become CLOSED while a loan is still OUT;
--   - approver = the acting user until an independent approval mechanism exists (SERVICE_APPROVER_NOT_ACTOR).
--
-- WHEN A LOAN MAY BE LENT (service_loan_insert_guard):
--   CHECKED_IN, DIAGNOSING, QUOTE_PENDING, IN_REPAIR, EXTERNAL, QA  — the work is under way: the normal path, no exception;
--   OPEN, SCHEDULED, READY                                          — only as an EXCEPTION: reason + approver + approval
--                                                                     time (approval kind LEND_OUTSIDE_WORK);
--   WORK_DONE, DELIVERED, ABANDONED, CLOSED, CANCELLED              — never;
--   and never while a cancel is pending or decided (cancellationRequested, or outcome CANCELLED).
--
--   "ServiceLoan"       one row per lent item; its current values only. state OUT → RETURNED | CLOSED (final).
--   "ServiceLoanEvent"  the append-only journal of a loan: seq = the loan's version after the change; the approval of an
--                       exception (kind, approver, reason) lives on the event that made it.
--
-- Guards: the insert guard (case lock, statuses, initial shape, the identifier normalized by the database); one change
-- kind per update; a deferred "no silent change"; the event mirrors the loan; the journal append-only; a deferred guard on
-- ServiceCase (no CLOSED with a loan out; CANCELLED / cancel pending / ABANDONED / DELIVERED only with the approval);
-- a BEFORE INSERT guard on ServiceHandover (a loan out ⇔ the loaner exception). Every write locks the case row first.
-- SECURITY DEFINER: one new function, service_loan_erase_business(). No DELETE for the runtime anywhere.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_LOANS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceCaseEvent"') IS NULL
     OR to_regclass('public."ServiceHandover"') IS NULL OR to_regclass('public."InventoryItem"') IS NULL
     OR to_regclass('public."User"') IS NULL OR to_regclass('public."Business"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_LOANS: ServiceCase, ServiceCaseEvent, ServiceHandover, InventoryItem, User or Business is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'InventoryItem_id_businessId_key') THEN
    RAISE EXCEPTION 'SERVICE_LOANS: a (businessId, id) key of ServiceCase / InventoryItem is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL
     OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_LOANS: a Service Desk trigger function this migration calls is missing; nothing was changed';
  END IF;
  -- #1128: the handover states who approved handing over with the loaner out
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover'
        AND column_name IN ('loanerOverrideReason', 'loanerApprovedByUserId', 'loanerApprovedAt')) <> 3
     OR to_regprocedure('public.service_handover_record_guard()') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_LOANS: the handover record (20261130090000) is not in place; nothing was changed';
  END IF;
  -- a second application (or a partial hand-made one) is refused before anything moves
  IF to_regclass('public."ServiceLoan"') IS NOT NULL OR to_regclass('public."ServiceLoanEvent"') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname IN
                  ('ServiceLoanState', 'ServiceLoanCondition', 'ServiceLoanCloseReason', 'ServiceLoanEventKind', 'ServiceLoanApprovalKind'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'service\_loan\_%') THEN
    RAISE EXCEPTION 'SERVICE_LOANS: already applied (a table, type or function of this migration exists); nothing was changed';
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceLoanState" AS ENUM ('OUT', 'RETURNED', 'CLOSED');
-- Generic for any lent item; the free-text note says the rest.
CREATE TYPE "ServiceLoanCondition" AS ENUM ('GOOD', 'WORN', 'DAMAGED', 'NOT_WORKING');
-- Why a loan is closed without coming back. Each needs an approval + reason.
CREATE TYPE "ServiceLoanCloseReason" AS ENUM ('LOST', 'KEPT_BY_CUSTOMER', 'WRITTEN_OFF');
CREATE TYPE "ServiceLoanEventKind" AS ENUM ('LENT', 'EXPECTED_RETURN_CHANGED', 'RETURNED', 'CLOSED', 'CASE_EXIT_APPROVED');
-- The exceptions recorded on the loan's journal (HANDOVER_OPEN_LOANER lives on ServiceHandover, #1128).
CREATE TYPE "ServiceLoanApprovalKind" AS ENUM ('LEND_OUTSIDE_WORK', 'LOAN_CLOSE_UNRETURNED', 'CANCEL_OPEN_LOANER', 'ABANDON_OPEN_LOANER');

-- ── 2. ServiceLoan ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceLoan" (
  "id"                       SERIAL NOT NULL,
  "businessId"               INTEGER NOT NULL,
  "caseId"                   INTEGER NOT NULL,
  -- the lent item: a free-text name (always), an optional serial / asset tag, an optional READ-ONLY inventory reference
  "itemName"                 TEXT,
  "itemIdentifier"           TEXT,
  -- set by the insert guard from itemIdentifier (whatever the writer sent); the key of the double-loan index
  "itemIdentifierNormalized" TEXT,
  "inventoryItemId"          INTEGER,
  "state"                    "ServiceLoanState" NOT NULL DEFAULT 'OUT',
  "lastEventKind"            "ServiceLoanEventKind" NOT NULL DEFAULT 'LENT',
  "version"                  INTEGER NOT NULL DEFAULT 1,
  -- lending (the times are stamped by the database: the transaction time)
  "lentAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lentByUserId"             INTEGER,
  "conditionAtLend"          "ServiceLoanCondition" NOT NULL,
  "lendNote"                 TEXT,
  "expectedReturnOn"         DATE,
  -- the lending exception (a case outside the work statuses): reason + approver + approval time
  "lendExceptionReason"      TEXT,
  "lendApprovedByUserId"     INTEGER,
  "lendApprovedAt"           TIMESTAMP(3),
  -- the return
  "returnedAt"               TIMESTAMP(3),
  "returnedByUserId"         INTEGER,
  "conditionAtReturn"        "ServiceLoanCondition",
  "returnNote"               TEXT,
  -- closed without a return (LOST / KEPT_BY_CUSTOMER / WRITTEN_OFF): always approved, always with a reason (closeNote)
  "closedAt"                 TIMESTAMP(3),
  "closedByUserId"           INTEGER,
  "closeReason"              "ServiceLoanCloseReason",
  "closeNote"                TEXT,
  "closeApprovedByUserId"    INTEGER,
  "closeApprovedAt"          TIMESTAMP(3),
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"                 TIMESTAMP(3),
  CONSTRAINT "ServiceLoan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceLoan_numbers" CHECK ("version" >= 1),
  -- OUT ⇔ neither returned nor closed; RETURNED carries the return; CLOSED carries the close and its approval time; a
  -- state's own columns exist only in that state.
  CONSTRAINT "ServiceLoan_state_shape" CHECK (
        ("state" = 'RETURNED') = ("returnedAt" IS NOT NULL)
    AND ("state" = 'RETURNED') = ("conditionAtReturn" IS NOT NULL)
    AND ("state" = 'RETURNED' OR ("returnedByUserId" IS NULL AND "returnNote" IS NULL))
    AND ("state" = 'CLOSED') = ("closedAt" IS NOT NULL)
    AND ("state" = 'CLOSED') = ("closeReason" IS NOT NULL)
    AND ("state" = 'CLOSED') = ("closeApprovedAt" IS NOT NULL)
    AND ("state" = 'CLOSED' OR ("closedByUserId" IS NULL AND "closeNote" IS NULL AND "closeApprovedByUserId" IS NULL))
    AND ("state" <> 'CLOSED' OR "closeNote" IS NOT NULL OR "erasedAt" IS NOT NULL)),
  -- the lending exception: reason ⇔ approval time; an approver only with an approval (it may be nulled later by the
  -- deleted user's FK action or the erasure, never set without one)
  CONSTRAINT "ServiceLoan_lend_exception" CHECK (
        ("lendExceptionReason" IS NULL OR "lendApprovedAt" IS NOT NULL)
    AND ("lendApprovedAt" IS NOT NULL OR "lendApprovedByUserId" IS NULL)
    AND ("lendApprovedAt" IS NULL OR "lendExceptionReason" IS NOT NULL OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "ServiceLoan_texts" CHECK (
        ("itemName" IS NOT NULL OR "erasedAt" IS NOT NULL)
    AND ("itemName" IS NULL OR (char_length("itemName") <= 200 AND btrim("itemName") <> '' AND "itemName" = btrim("itemName")))
    AND ("itemIdentifier" IS NULL OR (char_length("itemIdentifier") <= 100 AND btrim("itemIdentifier") <> '' AND "itemIdentifier" = btrim("itemIdentifier")))
    AND ("lendNote" IS NULL OR (char_length("lendNote") <= 1000 AND btrim("lendNote") <> '' AND "lendNote" = btrim("lendNote")))
    AND ("returnNote" IS NULL OR (char_length("returnNote") <= 1000 AND btrim("returnNote") <> '' AND "returnNote" = btrim("returnNote")))
    AND ("closeNote" IS NULL OR (char_length("closeNote") <= 1000 AND btrim("closeNote") <> '' AND "closeNote" = btrim("closeNote")))
    AND ("lendExceptionReason" IS NULL OR (char_length("lendExceptionReason") <= 1000 AND btrim("lendExceptionReason") <> '' AND "lendExceptionReason" = btrim("lendExceptionReason")))),
  -- the normalized identifier is exactly the database's normalization of the identifier (upper case, no blanks / . _ / -)
  CONSTRAINT "ServiceLoan_identifier_normalized" CHECK (
        ("itemIdentifier" IS NULL AND "itemIdentifierNormalized" IS NULL)
    OR ("itemIdentifierNormalized" = upper(regexp_replace("itemIdentifier", '[[:space:]._/-]+', '', 'g'))
        AND "itemIdentifierNormalized" ~ '^[^[:space:]]{1,100}$'))
);
CREATE UNIQUE INDEX "ServiceLoan_businessId_id_key" ON "ServiceLoan"("businessId", "id");
-- Never two open loans of the same identified item in a business — enforced by the index itself (race-safe at any isolation).
CREATE UNIQUE INDEX "ServiceLoan_one_out_per_identifier" ON "ServiceLoan"("businessId", "itemIdentifierNormalized")
  WHERE "state" = 'OUT' AND "itemIdentifierNormalized" IS NOT NULL;
CREATE INDEX "ServiceLoan_businessId_caseId_idx" ON "ServiceLoan"("businessId", "caseId");
CREATE INDEX "ServiceLoan_out_idx" ON "ServiceLoan"("businessId", "lentAt") WHERE "state" = 'OUT';
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- READ-ONLY reference (the ServicePart pattern): never a stock movement.
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_inventory_item_tenant_fkey"
  FOREIGN KEY ("inventoryItemId", "businessId") REFERENCES "InventoryItem"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_lentByUserId_fkey"
  FOREIGN KEY ("lentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_lendApprovedByUserId_fkey"
  FOREIGN KEY ("lendApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_returnedByUserId_fkey"
  FOREIGN KEY ("returnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_closedByUserId_fkey"
  FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceLoan" ADD CONSTRAINT "ServiceLoan_closeApprovedByUserId_fkey"
  FOREIGN KEY ("closeApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. ServiceLoanEvent — the append-only journal of a loan ─────────────────────────────────────────────────
CREATE TABLE "ServiceLoanEvent" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "loanId"           INTEGER NOT NULL,
  "caseId"           INTEGER NOT NULL,
  "seq"              INTEGER NOT NULL,
  "kind"             "ServiceLoanEventKind" NOT NULL,
  "stateAfter"       "ServiceLoanState" NOT NULL,
  "expectedReturnOn" DATE,
  -- LENT: the condition at lending; RETURNED: the condition at return; otherwise NULL
  "condition"        "ServiceLoanCondition",
  -- the exception this event approved: its kind, who approved (today = the actor), why (a business column, never in
  -- the payload) and, for a case exit, the case journal seq it approves
  "approvalKind"     "ServiceLoanApprovalKind",
  "approvedByUserId" INTEGER,
  "reason"           TEXT,
  "caseSeq"          INTEGER,
  "actor"            "ServiceActor" NOT NULL,
  "actorUserId"      INTEGER,
  "occurredAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload"          JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey"   TEXT NOT NULL,
  "requestDigest"    TEXT,
  "digestKeyId"      TEXT,
  "erasedAt"         TIMESTAMP(3),
  CONSTRAINT "ServiceLoanEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceLoanEvent_seq" CHECK ("seq" >= 1 AND ("seq" = 1) = ("kind" = 'LENT')),
  CONSTRAINT "ServiceLoanEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  -- which kind carries which approval; a case exit names its case seq; an approval keeps its reason until the erasure
  CONSTRAINT "ServiceLoanEvent_approval" CHECK (
        CASE "kind"
          WHEN 'LENT' THEN "approvalKind" IS NULL OR "approvalKind" = 'LEND_OUTSIDE_WORK'
          WHEN 'CLOSED' THEN "approvalKind" = 'LOAN_CLOSE_UNRETURNED'
          WHEN 'CASE_EXIT_APPROVED' THEN "approvalKind" IN ('CANCEL_OPEN_LOANER', 'ABANDON_OPEN_LOANER')
          ELSE "approvalKind" IS NULL END
    AND ("kind" = 'CASE_EXIT_APPROVED') = ("caseSeq" IS NOT NULL)
    AND ("caseSeq" IS NULL OR "caseSeq" >= 1)
    AND ("approvalKind" IS NOT NULL OR ("approvedByUserId" IS NULL AND "reason" IS NULL))
    AND ("approvalKind" IS NULL OR "reason" IS NOT NULL OR "erasedAt" IS NOT NULL)
    AND ("reason" IS NULL OR (char_length("reason") <= 1000 AND btrim("reason") <> '' AND "reason" = btrim("reason")))),
  CONSTRAINT "ServiceLoanEvent_condition" CHECK (("kind" IN ('LENT', 'RETURNED')) = ("condition" IS NOT NULL)),
  CONSTRAINT "ServiceLoanEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))),
  CONSTRAINT "ServiceLoanEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))'))
);
CREATE UNIQUE INDEX "ServiceLoanEvent_businessId_loanId_seq_key" ON "ServiceLoanEvent"("businessId", "loanId", "seq");
CREATE UNIQUE INDEX "ServiceLoanEvent_businessId_idempotencyKey_key" ON "ServiceLoanEvent"("businessId", "idempotencyKey");
CREATE INDEX "ServiceLoanEvent_businessId_caseId_idx" ON "ServiceLoanEvent"("businessId", "caseId");
CREATE INDEX "ServiceLoanEvent_businessId_occurredAt_idx" ON "ServiceLoanEvent"("businessId", "occurredAt");
ALTER TABLE "ServiceLoanEvent" ADD CONSTRAINT "ServiceLoanEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceLoanEvent" ADD CONSTRAINT "ServiceLoanEvent_loan_tenant_fkey"
  FOREIGN KEY ("businessId", "loanId") REFERENCES "ServiceLoan"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceLoanEvent" ADD CONSTRAINT "ServiceLoanEvent_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceLoanEvent" ADD CONSTRAINT "ServiceLoanEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceLoanEvent" ADD CONSTRAINT "ServiceLoanEvent_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- 4.0 Users of the same business — at INSERT only (the fixed pattern of ServiceCompletion, #1118 076d66aa): a user
-- column set later (the return, the close) is checked by the update guard (4.2) when it is SET; deleting a user only
-- nulls a column, and no same-business re-check of the other columns may then fail.
CREATE TRIGGER "ServiceLoan_user_same_business"
  BEFORE INSERT ON "ServiceLoan"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('lentByUserId', 'lendApprovedByUserId', 'returnedByUserId', 'closedByUserId', 'closeApprovedByUserId');
CREATE TRIGGER "ServiceLoanEvent_user_same_business"
  BEFORE INSERT ON "ServiceLoanEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId', 'approvedByUserId');

-- 4.1 INSERT: a loan of a case of the same business, in a status that admits it, at its initial state, by a named user;
-- an exception (outside the work statuses) names its reason and its approver = the actor. The case row is locked first
-- — the lock every loan write, the cancel, the abandon and the handover take — so they serialise per case; two loans of
-- the same item are decided by the partial UNIQUE index. The identifier is normalized HERE; lentAt / lendApprovedAt are
-- the transaction time.
CREATE OR REPLACE FUNCTION public.service_loan_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  work_status boolean;
  exception_status boolean;
BEGIN
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  SELECT "status", "outcome", "cancellationRequested" INTO c FROM "ServiceCase"
   WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_CASE_INVALID: the loan must name a case of the same business';
  END IF;
  work_status := c."status" IN ('CHECKED_IN', 'DIAGNOSING', 'QUOTE_PENDING', 'IN_REPAIR', 'EXTERNAL', 'QA');
  exception_status := c."status" IN ('OPEN', 'SCHEDULED', 'READY');
  IF NOT work_status AND NOT exception_status THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = format('SERVICE_LOAN_CASE_STATUS: nothing is lent on a %s case', c."status");
  END IF;
  IF c."cancellationRequested" OR c."outcome" IS NOT DISTINCT FROM 'CANCELLED' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_CASE_CANCELLING: nothing is lent on a case being cancelled';
  END IF;
  IF NEW."state" <> 'OUT' OR NEW."lastEventKind" <> 'LENT' OR NEW."version" <> 1 OR NEW."erasedAt" IS NOT NULL
     OR NEW."returnedAt" IS NOT NULL OR NEW."returnedByUserId" IS NOT NULL OR NEW."conditionAtReturn" IS NOT NULL OR NEW."returnNote" IS NOT NULL
     OR NEW."closedAt" IS NOT NULL OR NEW."closedByUserId" IS NOT NULL OR NEW."closeReason" IS NOT NULL OR NEW."closeNote" IS NOT NULL
     OR NEW."closeApprovedByUserId" IS NOT NULL OR NEW."closeApprovedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_NOT_INITIAL: a loan opens OUT / LENT / version 1, not returned, not closed, not erased';
  END IF;
  IF NEW."lentByUserId" IS NULL OR NEW."itemName" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_NEW: a loan names the lent item and is made by a named user';
  END IF;
  IF exception_status AND (NEW."lendExceptionReason" IS NULL OR NEW."lendApprovedByUserId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = format('SERVICE_LOAN_EXCEPTION_UNAPPROVED: lending on a %s case is an exception — reason and approver required', c."status");
  END IF;
  IF work_status AND (NEW."lendExceptionReason" IS NOT NULL OR NEW."lendApprovedByUserId" IS NOT NULL OR NEW."lendApprovedAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_NO_EXCEPTION: lending while the work is under way needs no exception approval';
  END IF;
  IF NEW."lendApprovedByUserId" IS NOT NULL AND NEW."lendApprovedByUserId" <> NEW."lentByUserId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_APPROVER_NOT_ACTOR: until an independent approver verification exists, the approver is the acting user';
  END IF;
  NEW."lentAt" := CURRENT_TIMESTAMP;
  NEW."lendApprovedAt" := CASE WHEN NEW."lendExceptionReason" IS NOT NULL THEN CURRENT_TIMESTAMP END;
  NEW."itemIdentifierNormalized" := CASE WHEN NEW."itemIdentifier" IS NOT NULL
    THEN upper(regexp_replace(NEW."itemIdentifier", '[[:space:]._/-]+', '', 'g')) END;
  IF NEW."itemIdentifierNormalized" = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'SERVICE_LOAN_IDENTIFIER_EMPTY: the identifier has no letter or digit';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_insert_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceLoan_insert_guard" BEFORE INSERT ON "ServiceLoan"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_insert_guard();

-- 4.2 UPDATE: every change is ONE named kind (lastEventKind) that bumps the version by one and changes exactly what that
-- kind may change; only an OUT loan changes (RETURNED and CLOSED are final — a second return is refused, never
-- re-written). The user a change sets is of the same business, and an approver is the actor. Only the loan erasure
-- (owner + marker) blanks text and users without a version bump; a deleted user's FK action may null a user id.
CREATE OR REPLACE FUNCTION public.service_loan_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_loan_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['itemName', 'itemIdentifier', 'itemIdentifierNormalized', 'lendNote', 'returnNote', 'closeNote',
                                    'lendExceptionReason', 'lentByUserId', 'lendApprovedByUserId', 'returnedByUserId', 'closedByUserId',
                                    'closeApprovedByUserId', 'erasedAt'];
  user_refs constant text[] := ARRAY['lentByUserId', 'lendApprovedByUserId', 'returnedByUserId', 'closedByUserId', 'closeApprovedByUserId'];
  bookkeeping constant text[] := ARRAY['version', 'lastEventKind', 'updatedAt'];
  allowed text[];
  k "ServiceLoanEventKind" := NEW."lastEventKind";
  col text;
  uid integer;
BEGIN
  IF in_erasure
     AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
     AND NEW."itemName" IS NULL AND NEW."itemIdentifier" IS NULL AND NEW."itemIdentifierNormalized" IS NULL
     AND NEW."lendNote" IS NULL AND NEW."returnNote" IS NULL AND NEW."closeNote" IS NULL AND NEW."lendExceptionReason" IS NULL
     AND NEW."lentByUserId" IS NULL AND NEW."lendApprovedByUserId" IS NULL AND NEW."returnedByUserId" IS NULL
     AND NEW."closedByUserId" IS NULL AND NEW."closeApprovedByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - user_refs) = (to_jsonb(OLD) - user_refs)
     AND (NEW."lentByUserId" IS NULL OR NEW."lentByUserId" = OLD."lentByUserId")
     AND (NEW."lendApprovedByUserId" IS NULL OR NEW."lendApprovedByUserId" = OLD."lendApprovedByUserId")
     AND (NEW."returnedByUserId" IS NULL OR NEW."returnedByUserId" = OLD."returnedByUserId")
     AND (NEW."closedByUserId" IS NULL OR NEW."closedByUserId" = OLD."closedByUserId")
     AND (NEW."closeApprovedByUserId" IS NULL OR NEW."closeApprovedByUserId" = OLD."closeApprovedByUserId") THEN
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'OUT' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = format('SERVICE_LOAN_FINAL: the loan is %s; its record never changes again', OLD."state");
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = format('SERVICE_LOAN_VERSION: a change moves the version from %s to %s, not %s', OLD."version", OLD."version" + 1, NEW."version");
  END IF;
  allowed := CASE k
    WHEN 'EXPECTED_RETURN_CHANGED' THEN ARRAY['expectedReturnOn']
    WHEN 'RETURNED' THEN ARRAY['state', 'returnedAt', 'returnedByUserId', 'conditionAtReturn', 'returnNote']
    WHEN 'CLOSED' THEN ARRAY['state', 'closedAt', 'closedByUserId', 'closeReason', 'closeNote', 'closeApprovedByUserId', 'closeApprovedAt']
    WHEN 'CASE_EXIT_APPROVED' THEN ARRAY[]::text[]
    ELSE NULL END;
  IF allowed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = format('SERVICE_LOAN_KIND: %s is not a change of an existing loan', k);
  END IF;
  IF (to_jsonb(NEW) - allowed - bookkeeping) <> (to_jsonb(OLD) - allowed - bookkeeping) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = format('SERVICE_LOAN_CHANGE_NOT_KIND: a %s changes only its own columns', k);
  END IF;
  IF k = 'EXPECTED_RETURN_CHANGED' AND NEW."expectedReturnOn" IS NOT DISTINCT FROM OLD."expectedReturnOn" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'SERVICE_LOAN_NO_CHANGE: the expected return date is the same';
  END IF;
  IF k = 'RETURNED' THEN
    IF NEW."state" <> 'RETURNED' OR NEW."returnedByUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'SERVICE_LOAN_RETURN: a return closes the loan RETURNED, by a named user';
    END IF;
    NEW."returnedAt" := CURRENT_TIMESTAMP;
  END IF;
  IF k = 'CLOSED' THEN
    IF NEW."state" <> 'CLOSED' OR NEW."closedByUserId" IS NULL OR NEW."closeApprovedByUserId" IS NULL OR NEW."closeNote" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'SERVICE_LOAN_CLOSE_UNAPPROVED: closing a loan that did not come back needs a reason and the approving user';
    END IF;
    IF NEW."closeApprovedByUserId" <> NEW."closedByUserId" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'SERVICE_APPROVER_NOT_ACTOR: until an independent approver verification exists, the approver is the acting user';
    END IF;
    NEW."closedAt" := CURRENT_TIMESTAMP;
    NEW."closeApprovedAt" := CURRENT_TIMESTAMP;
  END IF;
  -- a user this change SETS belongs to the business (the INSERT-only trigger does not see an UPDATE)
  FOREACH col IN ARRAY user_refs LOOP
    uid := (to_jsonb(NEW) ->> col)::integer;
    IF uid IS NOT NULL AND uid IS DISTINCT FROM (to_jsonb(OLD) ->> col)::integer
       AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS03', MESSAGE = format('SERVICE_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceLoan_guard" BEFORE UPDATE ON "ServiceLoan"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_guard();

-- 4.3 No silent change: at COMMIT the loan's current version has its event (an erasure keeps the version).
CREATE OR REPLACE FUNCTION public.service_loan_has_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  l record;
BEGIN
  SELECT "version", "lastEventKind" INTO l FROM "ServiceLoan" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."loanId" = NEW."id" AND e."seq" = l."version" AND e."kind" = l."lastEventKind") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZL03',
      MESSAGE = format('SERVICE_LOAN_SILENT_CHANGE: loan %s is at version %s (%s) with no journal event for it', NEW."id", l."version", l."lastEventKind");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_has_event() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceLoan_has_event" AFTER INSERT OR UPDATE ON "ServiceLoan"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_has_event();

-- 4.4 The event mirrors the loan as this transaction just left it: same case, seq = version, kind = lastEventKind, the
-- state, the expected date, the condition of a LENT / RETURNED; an approval mirrors the loan's approval columns (lend
-- exception, close) and a case exit names the case event it approves — a CANCEL / ABANDON at the case's current version,
-- written before it in this transaction. The approver is the actor (SERVICE_APPROVER_NOT_ACTOR); the actor is named.
CREATE OR REPLACE FUNCTION public.service_loan_event_matches_loan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  l record;
  case_version integer;
  case_action "ServiceCaseAction";
  want_action text;
BEGIN
  SELECT * INTO l FROM "ServiceLoan" WHERE "id" = NEW."loanId" AND "businessId" = NEW."businessId";
  IF NOT FOUND OR l."caseId" <> NEW."caseId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL04', MESSAGE = 'SERVICE_LOAN_EVENT_LOAN_INVALID: the event must name a loan (and its case) of the same business';
  END IF;
  IF NEW."actor" <> 'OWNER_USER' OR NEW."actorUserId" IS NULL OR NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL04', MESSAGE = 'SERVICE_LOAN_EVENT_ACTOR: a loan event is made by a named user and never born erased';
  END IF;
  IF NEW."approvalKind" IS NOT NULL AND (NEW."approvedByUserId" IS NULL OR NEW."reason" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL04', MESSAGE = 'SERVICE_LOAN_EVENT_UNAPPROVED: an approval names its approver and its reason';
  END IF;
  IF NEW."approvedByUserId" IS NOT NULL AND NEW."approvedByUserId" <> NEW."actorUserId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL04', MESSAGE = 'SERVICE_APPROVER_NOT_ACTOR: until an independent approver verification exists, the approver is the acting user';
  END IF;
  IF NEW."seq" <> l."version" OR NEW."kind" <> l."lastEventKind" OR NEW."stateAfter" <> l."state"
     OR NEW."expectedReturnOn" IS DISTINCT FROM l."expectedReturnOn"
     OR (NEW."kind" = 'LENT' AND (NEW."condition" IS DISTINCT FROM l."conditionAtLend"
          OR (NEW."approvalKind" IS NOT NULL) <> (l."lendExceptionReason" IS NOT NULL)
          OR NEW."reason" IS DISTINCT FROM l."lendExceptionReason" OR NEW."approvedByUserId" IS DISTINCT FROM l."lendApprovedByUserId"
          OR NEW."actorUserId" IS DISTINCT FROM l."lentByUserId"))
     OR (NEW."kind" = 'RETURNED' AND (NEW."condition" IS DISTINCT FROM l."conditionAtReturn" OR NEW."actorUserId" IS DISTINCT FROM l."returnedByUserId"))
     OR (NEW."kind" = 'CLOSED' AND (NEW."reason" IS DISTINCT FROM l."closeNote" OR NEW."approvedByUserId" IS DISTINCT FROM l."closeApprovedByUserId"
          OR NEW."actorUserId" IS DISTINCT FROM l."closedByUserId")) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZL04',
      MESSAGE = format('SERVICE_LOAN_EVENT_MISMATCH: event %s seq %s must mirror loan version %s (%s)', NEW."kind", NEW."seq", l."version", l."lastEventKind");
  END IF;
  IF NEW."kind" = 'CASE_EXIT_APPROVED' THEN
    want_action := CASE WHEN NEW."approvalKind" = 'CANCEL_OPEN_LOANER' THEN 'CANCEL' ELSE 'ABANDON' END;
    SELECT k."version" INTO case_version FROM "ServiceCase" k WHERE k."id" = NEW."caseId" AND k."businessId" = NEW."businessId";
    SELECT e."action" INTO case_action FROM "ServiceCaseEvent" e
     WHERE e."businessId" = NEW."businessId" AND e."caseId" = NEW."caseId" AND e."seq" = NEW."caseSeq";
    IF case_action IS NULL OR NEW."caseSeq" <> case_version OR case_action::text <> want_action THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZL04',
        MESSAGE = format('SERVICE_LOAN_EXIT_NOT_BOUND: %s must approve the case''s %s event at its current version', NEW."approvalKind", want_action);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_event_matches_loan() FROM PUBLIC;
CREATE TRIGGER "ServiceLoanEvent_matches_loan" BEFORE INSERT ON "ServiceLoanEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_event_matches_loan();

-- 4.5 The journal is append-only and the loan is never deleted: no UPDATE of an event but the erasure's scrub (users,
-- digests, reasons) and a deleted user's FK action; no DELETE of either table but the cascade of a deleted business; no
-- TRUNCATE.
CREATE OR REPLACE FUNCTION public.service_loan_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_loan_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  scrubbable constant text[] := ARRAY['actorUserId', 'approvedByUserId', 'requestDigest', 'digestKeyId', 'reason', 'erasedAt'];
  user_refs constant text[] := ARRAY['actorUserId', 'approvedByUserId'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."approvedByUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL
       AND NEW."reason" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - user_refs) = (to_jsonb(OLD) - user_refs)
       AND (NEW."actorUserId" IS NULL OR NEW."actorUserId" = OLD."actorUserId")
       AND (NEW."approvedByUserId" IS NULL OR NEW."approvedByUserId" = OLD."approvedByUserId") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZL05',
    MESSAGE = format('SERVICE_LOAN_APPEND_ONLY: %s on %I is refused; a loan and its journal are a permanent record', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceLoanEvent_append_only" BEFORE UPDATE OR DELETE ON "ServiceLoanEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_event_guard();
CREATE TRIGGER "ServiceLoanEvent_no_truncate" BEFORE TRUNCATE ON "ServiceLoanEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();
-- the DELETE branch of the same guard: a loan row is deleted only by the cascade of a deleted business
CREATE TRIGGER "ServiceLoan_no_delete" BEFORE DELETE ON "ServiceLoan"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_event_guard();
CREATE TRIGGER "ServiceLoan_no_truncate" BEFORE TRUNCATE ON "ServiceLoan"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.6 A case never loses track of a loan that is still OUT (checked at COMMIT, per case, whenever its status, outcome or
-- cancel request changes):
--   CLOSED                                         refused while a loan is OUT (return it, or close it with approval first);
--   CANCELLED, or a cancel pending / decided       every OUT loan carries its CANCEL_OPEN_LOANER approval;
--   ABANDONED                                      every OUT loan carries its ABANDON_OPEN_LOANER approval;
--   DELIVERED                                      the handover carries the loaner exception (#1128 columns).
-- The loan itself is never touched: it stays OUT until a real return or an approved close.
CREATE OR REPLACE FUNCTION public.service_loan_case_exit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  l record;
BEGIN
  SELECT "status", "outcome", "cancellationRequested" INTO c FROM "ServiceCase" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  FOR l IN SELECT x."id" FROM "ServiceLoan" x WHERE x."businessId" = NEW."businessId" AND x."caseId" = NEW."id" AND x."state" = 'OUT' LOOP
    IF c."status" = 'CLOSED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = format('SERVICE_LOAN_OUT_ON_CLOSE: case %s cannot close while loan %s is out', NEW."id", l."id");
    END IF;
    IF (c."status" = 'CANCELLED' OR c."cancellationRequested" OR c."outcome" IS NOT DISTINCT FROM 'CANCELLED')
       AND NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e WHERE e."businessId" = NEW."businessId" AND e."loanId" = l."id"
                         AND e."kind" = 'CASE_EXIT_APPROVED' AND e."approvalKind" = 'CANCEL_OPEN_LOANER') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = format('SERVICE_LOAN_CANCEL_UNAPPROVED: case %s is cancelled while loan %s is out, with no approval', NEW."id", l."id");
    END IF;
    IF c."status" = 'ABANDONED'
       AND NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e WHERE e."businessId" = NEW."businessId" AND e."loanId" = l."id"
                         AND e."kind" = 'CASE_EXIT_APPROVED' AND e."approvalKind" = 'ABANDON_OPEN_LOANER') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = format('SERVICE_LOAN_ABANDON_UNAPPROVED: case %s is abandoned while loan %s is out, with no approval', NEW."id", l."id");
    END IF;
    IF c."status" = 'DELIVERED'
       AND NOT EXISTS (SELECT 1 FROM "ServiceHandover" h WHERE h."businessId" = NEW."businessId" AND h."caseId" = NEW."id"
                         AND (h."loanerApprovedAt" IS NOT NULL OR h."loanerOverrideReason" IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = format('SERVICE_LOAN_DELIVER_UNAPPROVED: case %s is delivered while loan %s is out, with no approval', NEW."id", l."id");
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_case_exit_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_loan_exit_guard" AFTER UPDATE OF "status", "outcome", "cancellationRequested" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_case_exit_guard();

-- 4.7 The handover and the loaner exception, both ways (owner 2026-11-12):
--   a loan of the case is OUT  ⇒ the handover carries the loaner exception (SERVICE_HANDOVER_LOANER_OUT);
--   no loan of the case is OUT ⇒ the handover carries none of it — no reason, no approver, no approval time
--                                (SERVICE_HANDOVER_LOANER_NONE): an approval with nothing to approve is never saved.
-- "The exception" = any of the three loaner columns; that it is complete (reason ⇔ approval time, an approver, approver =
-- actor, server-resolved) is #1128's rule (CHECK ServiceHandover_loaner_decided + service_handover_record_guard), so a
-- partial one is refused there either way. INSERT only: a saved handover never changes (service_handover_guard, #1128),
-- and the rows written before this migration — legacy version 1 and version 2 alike, with or without a loaner reason —
-- are not re-judged (the preflight counts them, INFO).
-- Race-free by lock order: the case row FOR UPDATE first — the lock the loan insert guard, the handover service, every
-- loan write of the service, the cancel and the abandon take first — so a handover and a NEW loan of one case serialise
-- and the second one reads the first one's commit (READ COMMITTED: each statement here takes a fresh snapshot); then the
-- case's OUT loans FOR SHARE — a return / close in flight is waited for and the row re-read, and at REPEATABLE READ /
-- SERIALIZABLE a loan changed after this transaction's snapshot fails the handover (serialization failure, retried by
-- the caller) instead of being judged by a stale "out". (A writer that takes the loan row before the case breaks that
-- order; the worst it meets is a detected deadlock — one side refused, never a wrong record.)
CREATE OR REPLACE FUNCTION public.service_loan_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  has_exception constant boolean := NEW."loanerOverrideReason" IS NOT NULL OR NEW."loanerApprovedByUserId" IS NOT NULL
                                    OR NEW."loanerApprovedAt" IS NOT NULL;
  loan_out boolean;
BEGIN
  PERFORM 1 FROM "ServiceCase" WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  PERFORM 1 FROM "ServiceLoan" l WHERE l."businessId" = NEW."businessId" AND l."caseId" = NEW."caseId" AND l."state" = 'OUT' FOR SHARE;
  loan_out := FOUND;
  IF loan_out AND NOT has_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL07', MESSAGE = 'SERVICE_HANDOVER_LOANER_OUT: a loan of this case is still out; return it or approve the handover with it out';
  END IF;
  IF has_exception AND NOT loan_out THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL07', MESSAGE = 'SERVICE_HANDOVER_LOANER_NONE: no loan of this case is out; a loaner approval or reason has nothing to approve and is not saved';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_handover_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceHandover_loan_guard" BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_loan_handover_guard();

-- ── 5. Account erasure: the one SECURITY DEFINER function ───────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZL08, nothing changed) without a context or when
-- that business is not being deleted. Otherwise blanks, for that business only: the loan's free texts (item name,
-- identifier and its normalized form, notes, the lending exception reason, the close reason) and its five users; in the
-- journal the actor, the approver, the reason and the request digest; stamps erasedAt. Kept: states, conditions, close
-- reasons (enum), dates and times, the inventory reference (the business's own item), the versions. Returns rows touched;
-- re-run safe (0 the second time). The account-deletion flow calls it in its purge transaction.
CREATE OR REPLACE FUNCTION public.service_loan_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZL08', MESSAGE = 'SERVICE_LOAN_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL08', MESSAGE = 'SERVICE_LOAN_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_loan_erasure', 'on', true);

  UPDATE public."ServiceLoan" SET "itemName" = NULL, "itemIdentifier" = NULL, "itemIdentifierNormalized" = NULL, "lendNote" = NULL,
         "returnNote" = NULL, "closeNote" = NULL, "lendExceptionReason" = NULL, "lentByUserId" = NULL, "lendApprovedByUserId" = NULL,
         "returnedByUserId" = NULL, "closedByUserId" = NULL, "closeApprovedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceLoanEvent" SET "actorUserId" = NULL, "approvedByUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL,
         "reason" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_loan_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_loan_erase_business() FROM PUBLIC;

-- ── 6. Row-level security — per operation, no DELETE policy ─────────────────────────────────────────────────
ALTER TABLE "ServiceLoan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceLoan" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_loan_tenant_select ON "ServiceLoan" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_loan_tenant_insert ON "ServiceLoan" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_loan_tenant_update ON "ServiceLoan" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceLoanEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceLoanEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_loan_event_tenant_select ON "ServiceLoanEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_loan_event_tenant_insert ON "ServiceLoanEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceLoan", "ServiceLoanEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceLoan_id_seq", "ServiceLoanEvent_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceLoan', 'ServiceLoanEvent', 'ServiceLoan_id_seq', 'ServiceLoanEvent_id_seq')
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
GRANT SELECT, INSERT, UPDATE ON "ServiceLoan" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceLoan_id_seq" TO app_runtime;
GRANT SELECT, INSERT ON "ServiceLoanEvent" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceLoanEvent_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_loan_erase_business() TO app_runtime;
