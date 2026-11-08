-- ============================================================================================================
-- 20261115090000_service_parts — Service Desk 1.2c / M2: spare parts of a service case (חלקי חילוף בקריאת שירות).
--
-- PR-1 of the migration-first rule: this migration and its PG17 lab only. No schema.prisma, no runtime code, no flag.
-- Expand-only: two NEW tables, five NEW enum types, their own functions, and two NEW invoker constraint triggers on
-- 1.2a / 1.2b tables ("ServiceCase", "ServiceExternalWork") that only REFUSE — no existing column, policy, grant,
-- row or function changes. Inventory, purchasing and billing tables are referenced, never altered.
--
--   "ServicePart"       one row per part line of a case (state, source, quantity, the stock movements that moved it,
--                       the captured cost and its source, the customer price, links to quote / supplier work / order).
--   "ServicePartEvent"  append-only journal of every change of a part line: seq = the line's version after it.
--
-- Owner decisions (2026-11-05 / 06), mirroring the pure core M1 (lib/services/service-desk/parts.*):
--   - the inventory module is the only stock: this migration never writes InventoryItem / InventoryMovement; a part
--     line only LINKS the one OUT movement of its issue and the one IN movement of its return (UNIQUE), and a trigger
--     proves the linked movement is of that item, that direction, that reason (as text: SERVICE_PART / RETURN — the
--     enum value SERVICE_PART is M0's, inventory session) and that quantity;
--   - soft reservation (state RESERVED) — the arithmetic is the service layer's (M3), under the item row lock;
--   - ק‑3 / M2‑2: a case cannot become CLOSED while a part is open (deferred check); a cancel request is never refused;
--     the case status machine is unchanged — CANCELLED (FIELD / nothing held) is never evidence that parts are done;
--   - M2‑1: a supplier work cannot be RETURNED while a part sent with it is still ISSUED (deferred check);
--   - ק‑4 / M2‑4: a line splits only for a partial return — the child is RETURNED; the family's quantities reconcile
--     with the issue movement (deferred check); partial install / write-off are NOT allowed;
--   - ק‑9: the captured cost and its source are history; a change is only a COST_CORRECTED event with the previous
--     value and a reason; a supplier part inside the supplier's cost carries no cost of its own;
--   - every part change takes the CASE row FOR UPDATE first — 1.2b's convention; FOR SHARE would deadlock with 1.2b's
--     FOR UPDATE triggers (proven: .sdp/locks.ts B4) — and a send-with-supplier then locks the work FOR SHARE.
-- Every change names its kind (lastEventKind); the guard checks the change IS that kind, the event must say the same,
-- and a deferred constraint trigger requires the event of every version at COMMIT — no silent change.
-- SECURITY DEFINER: one new function, service_parts_erase_business(), search_path … pg_temp last. No existing erasure
-- function changes. No DELETE for the runtime anywhere.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_PARTS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceExternalWork"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_PARTS: the Service Desk foundation (20261112090000) or the external work (20261113090000) is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceDevice_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceQuote_businessId_caseId_version_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceExternalWork_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'InventoryItem_id_businessId_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'InventoryMovement_id_businessId_key') THEN
    RAISE EXCEPTION 'SERVICE_PARTS: a composite key this migration references is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_PARTS: the foundation trigger functions are missing; nothing was changed';
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServicePartState" AS ENUM (
  'NEEDED', 'ON_ORDER', 'RESERVED', 'ISSUED', 'INSTALLED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED');
CREATE TYPE "ServicePartSource" AS ENUM ('STOCK', 'SUPPLIER', 'NON_STOCK');
CREATE TYPE "ServicePartCostSource" AS ENUM ('LAST_PURCHASE', 'ITEM_COST', 'MANUAL', 'NONE');
CREATE TYPE "ServicePartWriteOffReason" AS ENUM ('DAMAGED', 'LOST', 'KEPT_BY_SUPPLIER');
CREATE TYPE "ServicePartEventKind" AS ENUM (
  'ADDED', 'SPLIT', 'RESERVED', 'RELEASED', 'ORDER_LINKED', 'ORDER_UPDATED', 'ISSUED', 'INSTALLED', 'RETURNED',
  'WRITTEN_OFF', 'CANCELLED', 'PRICE_SET', 'QUOTED', 'COST_CORRECTED', 'SENT_WITH_EXTERNAL', 'BACK_FROM_EXTERNAL',
  'SUPPLIER_PART_RECORDED');

-- ── 2. ServicePart ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServicePart" (
  "id"                      SERIAL NOT NULL,
  "businessId"              INTEGER NOT NULL,
  "caseId"                  INTEGER NOT NULL,
  -- Copied from the case by the insert trigger (whatever the writer sent); fixed for the life of the row.
  "deviceId"                INTEGER,
  "source"                  "ServicePartSource" NOT NULL,
  "state"                   "ServicePartState" NOT NULL DEFAULT 'NEEDED',
  "inventoryItemId"         INTEGER,
  "nameSnapshot"            TEXT NOT NULL,
  "skuSnapshot"             TEXT,
  "unitType"                "InventoryUnitType",
  "quantity"                DOUBLE PRECISION NOT NULL,
  "issueMovementId"         INTEGER,
  "returnMovementId"        INTEGER,
  "splitFromPartId"         INTEGER,
  "unitCostAgorot"          INTEGER,
  "costSource"              "ServicePartCostSource",
  "customerUnitPriceAgorot" INTEGER,
  "quotedInVersion"         INTEGER,
  "costIncludedInExternal"  BOOLEAN NOT NULL DEFAULT false,
  "externalWorkId"          INTEGER,
  "purchaseOrderId"         INTEGER,
  "purchaseOrderLineId"     INTEGER,
  "expectedOn"              DATE,
  "writeOffReason"          "ServicePartWriteOffReason",
  "reason"                  TEXT,
  "note"                    TEXT,
  "version"                 INTEGER NOT NULL DEFAULT 1,
  "lastEventKind"           "ServicePartEventKind" NOT NULL DEFAULT 'ADDED',
  "createdByUserId"         INTEGER,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"                TIMESTAMP(3),
  "erasedAt"                TIMESTAMP(3),
  CONSTRAINT "ServicePart_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServicePart_numbers" CHECK ("version" >= 1 AND ("quotedInVersion" IS NULL OR "quotedInVersion" >= 1)),
  -- A quantity > 0, whole for counted units (UNIT / BOX).
  CONSTRAINT "ServicePart_quantity" CHECK (
    "quantity" > 0 AND ("unitType" IS NULL OR "unitType" NOT IN ('UNIT', 'BOX') OR "quantity" = trunc("quantity"))),
  -- STOCK ⇔ an inventory item; only STOCK lines ever link stock movements.
  CONSTRAINT "ServicePart_source_item" CHECK (
        ("source" = 'STOCK') = ("inventoryItemId" IS NOT NULL)
    AND ("source" = 'STOCK' OR ("issueMovementId" IS NULL AND "returnMovementId" IS NULL))),
  -- A STOCK line links its OUT movement exactly when it left the stock by its own issue (a split child left through
  -- its parent's); it links its IN movement exactly when it went back.
  CONSTRAINT "ServicePart_movements" CHECK (
        "source" <> 'STOCK'
    OR (    ("issueMovementId" IS NOT NULL) = ("state" IN ('ISSUED', 'INSTALLED', 'WRITTEN_OFF', 'RETURNED') AND "splitFromPartId" IS NULL)
        AND ("returnMovementId" IS NOT NULL) = ("state" = 'RETURNED'))),
  -- M2‑4 not approved: a split child is only a partial RETURN.
  CONSTRAINT "ServicePart_split_child" CHECK ("splitFromPartId" IS NULL OR "state" = 'RETURNED'),
  CONSTRAINT "ServicePart_write_off" CHECK (("writeOffReason" IS NOT NULL) = ("state" = 'WRITTEN_OFF')),
  CONSTRAINT "ServicePart_closed" CHECK (("closedAt" IS NOT NULL) = ("state" IN ('INSTALLED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED'))),
  -- ק‑9: a cost is captured when a STOCK / NON_STOCK line leaves the stock; NONE = unknown, never a value; a supplier
  -- part inside the supplier's cost carries no cost of its own (counted once, on the supplier work).
  CONSTRAINT "ServicePart_costs" CHECK (
        ("unitCostAgorot" IS NULL OR "unitCostAgorot" >= 0)
    AND ("customerUnitPriceAgorot" IS NULL OR "customerUnitPriceAgorot" >= 0)
    AND ("costSource" IS DISTINCT FROM 'NONE' OR "unitCostAgorot" IS NULL)
    AND (NOT "costIncludedInExternal" OR ("source" = 'SUPPLIER' AND "unitCostAgorot" IS NULL AND "costSource" IS NULL))
    AND ("source" = 'SUPPLIER'
         OR ("costSource" IS NOT NULL) = ("state" IN ('ISSUED', 'INSTALLED', 'WRITTEN_OFF', 'RETURNED')))),
  -- A supplier's part is recorded installed, with the supplier work it came with.
  CONSTRAINT "ServicePart_supplier" CHECK (
    "source" <> 'SUPPLIER' OR ("externalWorkId" IS NOT NULL AND "state" = 'INSTALLED')),
  CONSTRAINT "ServicePart_order" CHECK ("purchaseOrderLineId" IS NULL OR "purchaseOrderId" IS NOT NULL),
  CONSTRAINT "ServicePart_texts" CHECK (
        (char_length("nameSnapshot") BETWEEN 1 AND 200 AND btrim("nameSnapshot") <> '' AND "nameSnapshot" = btrim("nameSnapshot"))
    AND ("skuSnapshot" IS NULL OR (char_length("skuSnapshot") <= 200 AND btrim("skuSnapshot") <> '' AND "skuSnapshot" = btrim("skuSnapshot")))
    AND ("reason" IS NULL OR (char_length("reason") <= 1000 AND btrim("reason") <> '' AND "reason" = btrim("reason")))
    AND ("note" IS NULL OR (char_length("note") <= 1000 AND btrim("note") <> '' AND "note" = btrim("note"))))
);
CREATE UNIQUE INDEX "ServicePart_businessId_id_key" ON "ServicePart"("businessId", "id");
-- One movement, one part, one direction — enforced by the indexes themselves.
CREATE UNIQUE INDEX "ServicePart_issueMovementId_key" ON "ServicePart"("issueMovementId");
CREATE UNIQUE INDEX "ServicePart_returnMovementId_key" ON "ServicePart"("returnMovementId");
CREATE INDEX "ServicePart_businessId_caseId_idx" ON "ServicePart"("businessId", "caseId");
CREATE INDEX "ServicePart_open_by_case" ON "ServicePart"("businessId", "caseId")
  WHERE "state" IN ('NEEDED', 'ON_ORDER', 'RESERVED', 'ISSUED');
CREATE INDEX "ServicePart_reserved_by_item" ON "ServicePart"("businessId", "inventoryItemId") WHERE "state" = 'RESERVED';
CREATE INDEX "ServicePart_at_supplier" ON "ServicePart"("businessId", "externalWorkId") WHERE "state" = 'ISSUED';
CREATE INDEX "ServicePart_on_order" ON "ServicePart"("businessId", "purchaseOrderId") WHERE "state" = 'ON_ORDER';
CREATE INDEX "ServicePart_businessId_splitFromPartId_idx" ON "ServicePart"("businessId", "splitFromPartId");
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_device_tenant_fkey"
  FOREIGN KEY ("businessId", "deviceId") REFERENCES "ServiceDevice"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_item_tenant_fkey"
  FOREIGN KEY ("inventoryItemId", "businessId") REFERENCES "InventoryItem"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_issue_movement_tenant_fkey"
  FOREIGN KEY ("issueMovementId", "businessId") REFERENCES "InventoryMovement"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_return_movement_tenant_fkey"
  FOREIGN KEY ("returnMovementId", "businessId") REFERENCES "InventoryMovement"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_split_parent_tenant_fkey"
  FOREIGN KEY ("businessId", "splitFromPartId") REFERENCES "ServicePart"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_quote_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId", "quotedInVersion") REFERENCES "ServiceQuote"("businessId", "caseId", "version") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_external_work_tenant_fkey"
  FOREIGN KEY ("businessId", "externalWorkId") REFERENCES "ServiceExternalWork"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePart" ADD CONSTRAINT "ServicePart_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. ServicePartEvent — the append-only journal of a part line ────────────────────────────────────────────
CREATE TABLE "ServicePartEvent" (
  "id"                   SERIAL NOT NULL,
  "businessId"           INTEGER NOT NULL,
  "partId"               INTEGER NOT NULL,
  "caseId"               INTEGER NOT NULL,
  "seq"                  INTEGER NOT NULL,
  "kind"                 "ServicePartEventKind" NOT NULL,
  "stateBefore"          "ServicePartState",
  "stateAfter"           "ServicePartState" NOT NULL,
  "quantity"             DOUBLE PRECISION NOT NULL,
  "movementId"           INTEGER,
  "amountAgorot"         INTEGER,
  "previousAmountAgorot" INTEGER,
  -- A correction / cancel reason (a business column, cleared on account erasure — never in the payload).
  "reason"               TEXT,
  "actor"                "ServiceActor" NOT NULL,
  "actorUserId"          INTEGER,
  "occurredAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload"              JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey"       TEXT NOT NULL,
  "requestDigest"        TEXT,
  "digestKeyId"          TEXT,
  "erasedAt"             TIMESTAMP(3),
  CONSTRAINT "ServicePartEvent_pkey" PRIMARY KEY ("id"),
  -- seq 1 opens a line (ADDED / SUPPLIER_PART_RECORDED / a split child's RETURNED); the openings have no state before.
  CONSTRAINT "ServicePartEvent_seq" CHECK (
        "seq" >= 1 AND "quantity" > 0
    AND (("kind" IN ('ADDED', 'SUPPLIER_PART_RECORDED')) = ("stateBefore" IS NULL))
    AND ("kind" NOT IN ('ADDED', 'SUPPLIER_PART_RECORDED') OR "seq" = 1)
    AND ("seq" <> 1 OR "kind" IN ('ADDED', 'SUPPLIER_PART_RECORDED', 'RETURNED'))),
  CONSTRAINT "ServicePartEvent_only_owner_has_user" CHECK ("actor" = 'OWNER_USER' OR "actorUserId" IS NULL),
  CONSTRAINT "ServicePartEvent_amounts" CHECK (
        ("amountAgorot" IS NULL OR "amountAgorot" >= 0)
    AND ("previousAmountAgorot" IS NULL OR "previousAmountAgorot" >= 0)
    AND ("kind" <> 'COST_CORRECTED' OR ("amountAgorot" IS NOT NULL AND "previousAmountAgorot" IS DISTINCT FROM "amountAgorot"))),
  CONSTRAINT "ServicePartEvent_reason" CHECK (
        ("reason" IS NULL OR ("kind" IN ('COST_CORRECTED', 'CANCELLED', 'WRITTEN_OFF') AND char_length("reason") <= 1000 AND btrim("reason") <> '' AND "reason" = btrim("reason")))
    AND ("kind" <> 'COST_CORRECTED' OR "reason" IS NOT NULL OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "ServicePartEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL))),
  CONSTRAINT "ServicePartEvent_payload_closed" CHECK (
        jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 4096
    AND NOT jsonb_path_exists("payload", 'strict $.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_:.-]{0,64}$"))'))
);
CREATE UNIQUE INDEX "ServicePartEvent_businessId_partId_seq_key" ON "ServicePartEvent"("businessId", "partId", "seq");
CREATE UNIQUE INDEX "ServicePartEvent_businessId_idempotencyKey_key" ON "ServicePartEvent"("businessId", "idempotencyKey");
CREATE INDEX "ServicePartEvent_businessId_occurredAt_idx" ON "ServicePartEvent"("businessId", "occurredAt");
ALTER TABLE "ServicePartEvent" ADD CONSTRAINT "ServicePartEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicePartEvent" ADD CONSTRAINT "ServicePartEvent_part_tenant_fkey"
  FOREIGN KEY ("businessId", "partId") REFERENCES "ServicePart"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePartEvent" ADD CONSTRAINT "ServicePartEvent_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePartEvent" ADD CONSTRAINT "ServicePartEvent_movement_tenant_fkey"
  FOREIGN KEY ("movementId", "businessId") REFERENCES "InventoryMovement"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePartEvent" ADD CONSTRAINT "ServicePartEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "ServicePart_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId" ON "ServicePart"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('createdByUserId');
CREATE TRIGGER "ServicePartEvent_user_same_business"
  BEFORE INSERT ON "ServicePartEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- 4.0 A linked stock movement must BE the part's: same item, OUT SERVICE_PART −quantity for the issue, IN RETURN
-- +quantity for the return, and never linked to another part in the other direction. The reason is compared as text
-- so this migration does not depend on M0's enum value. Read under the caller's tenant RLS (invoker).
CREATE OR REPLACE FUNCTION public.service_part_check_movement(p_business integer, p_item integer, p_movement integer, p_direction text, p_quantity double precision)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  m record;
BEGIN
  SELECT "itemId", "movementType"::text AS t, "reason"::text AS r, "quantityDelta" AS d INTO m
    FROM "InventoryMovement" WHERE "id" = p_movement AND "businessId" = p_business;
  IF NOT FOUND
     OR m."itemId" <> p_item
     OR (p_direction = 'OUT' AND NOT (m.t = 'OUT' AND m.r = 'SERVICE_PART' AND abs(m.d + p_quantity) <= 1e-9))
     OR (p_direction = 'IN' AND NOT (m.t = 'IN' AND m.r = 'RETURN' AND abs(m.d - p_quantity) <= 1e-9)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP01', MESSAGE = format('SERVICE_PART_MOVEMENT_MISMATCH: movement %s is not the %s of this part (item, type, reason, quantity)', p_movement, p_direction);
  END IF;
  IF EXISTS (SELECT 1 FROM "ServicePart" s WHERE s."businessId" = p_business
               AND ((p_direction = 'OUT' AND s."returnMovementId" = p_movement) OR (p_direction = 'IN' AND s."issueMovementId" = p_movement))) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP01', MESSAGE = format('SERVICE_PART_MOVEMENT_REUSED: movement %s is already linked in the other direction', p_movement);
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_check_movement(integer, integer, integer, text, double precision) FROM PUBLIC;

-- 4.0b A purchase-order link must name an order (and line) this business can see — PurchaseOrder has no
-- (businessId, id) key, so it is checked here, under PurchaseOrder's own tenant RLS (invoker).
CREATE OR REPLACE FUNCTION public.service_part_check_order(p_business integer, p_order integer, p_line integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF p_order IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PurchaseOrder" o WHERE o."id" = p_order AND o."businessId" = p_business)
     OR (p_line IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PurchaseOrderLine" l WHERE l."id" = p_line AND l."purchaseOrderId" = p_order)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP02', MESSAGE = 'SERVICE_PART_ORDER_INVALID: the purchase order (and line) must be of the same business';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_check_order(integer, integer, integer) FROM PUBLIC;

-- 4.1 INSERT: a line is ADDED (NEEDED, STOCK / NON_STOCK), a supplier part is RECORDED (INSTALLED, with a work of the
-- same case), or a split child is born RETURNED from an ISSUED parent of the same case, item and cost. The case row
-- is locked FIRST, FOR UPDATE — the lock 1.2b's send and handover guards take — and a CLOSED / CANCELLED case gets no
-- new line (a split child is a resolution and may follow a cancel). The device is copied from the case.
CREATE OR REPLACE FUNCTION public.service_part_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  p record;
  w record;
BEGIN
  SELECT "status", "deviceId" INTO c FROM "ServiceCase"
   WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_CASE_INVALID: the part must name a case of the same business';
  END IF;
  NEW."deviceId" := c."deviceId";
  IF NEW."version" <> 1 OR NEW."erasedAt" IS NOT NULL OR NEW."issueMovementId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_NOT_INITIAL: a new line starts at version 1, not erased, without an issue movement';
  END IF;
  IF NEW."splitFromPartId" IS NULL AND (NEW."quotedInVersion" IS NOT NULL OR NEW."purchaseOrderId" IS NOT NULL OR NEW."expectedOn" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_NOT_INITIAL: a new line starts unquoted and unordered';
  END IF;
  IF NEW."splitFromPartId" IS NOT NULL THEN
    SELECT * INTO p FROM "ServicePart" WHERE "id" = NEW."splitFromPartId" AND "businessId" = NEW."businessId" FOR UPDATE;
    IF NOT FOUND OR p."caseId" <> NEW."caseId" OR p."state" <> 'ISSUED' OR p."splitFromPartId" IS NOT NULL
       OR p."source" <> NEW."source" OR p."inventoryItemId" IS DISTINCT FROM NEW."inventoryItemId"
       OR p."externalWorkId" IS NOT NULL
       OR NEW."state" <> 'RETURNED' OR NEW."lastEventKind" <> 'RETURNED'
       OR NEW."unitCostAgorot" IS DISTINCT FROM p."unitCostAgorot" OR NEW."costSource" IS DISTINCT FROM p."costSource"
       OR NEW."customerUnitPriceAgorot" IS DISTINCT FROM p."customerUnitPriceAgorot"
       OR NEW."nameSnapshot" <> p."nameSnapshot" OR NEW."unitType" IS DISTINCT FROM p."unitType" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_SPLIT_INVALID: a split child is the RETURNED share of an ISSUED line of the same case, item and cost';
    END IF;
    IF NEW."source" = 'STOCK' THEN
      PERFORM public.service_part_check_movement(NEW."businessId", NEW."inventoryItemId", NEW."returnMovementId", 'IN', NEW."quantity");
    END IF;
    RETURN NEW;
  END IF;
  IF c."status" IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = format('SERVICE_PART_CASE_FINISHED: the case is %s', c."status");
  END IF;
  IF NEW."source" = 'SUPPLIER' THEN
    SELECT "caseId" INTO w FROM "ServiceExternalWork" WHERE "id" = NEW."externalWorkId" AND "businessId" = NEW."businessId" FOR SHARE;
    IF NOT FOUND OR w."caseId" <> NEW."caseId" OR NEW."state" <> 'INSTALLED' OR NEW."lastEventKind" <> 'SUPPLIER_PART_RECORDED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_SUPPLIER_INVALID: a supplier part is recorded INSTALLED with a supplier work of the same case';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."state" <> 'NEEDED' OR NEW."lastEventKind" <> 'ADDED' OR NEW."externalWorkId" IS NOT NULL OR NEW."returnMovementId" IS NOT NULL
     OR NEW."unitCostAgorot" IS NOT NULL OR NEW."costSource" IS NOT NULL OR NEW."writeOffReason" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP03', MESSAGE = 'SERVICE_PART_NOT_INITIAL: a line is ADDED as NEEDED, with no cost, movement or supplier work yet';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_insert_guard() FROM PUBLIC;
CREATE TRIGGER "ServicePart_insert_guard" BEFORE INSERT ON "ServicePart"
  FOR EACH ROW EXECUTE FUNCTION public.service_part_insert_guard();

-- 4.2 UPDATE: every change is ONE named kind (lastEventKind) that bumps the version by one, moves the state only as
-- that kind may, and changes exactly what that kind may change. The case row is locked first (FOR UPDATE). Only the
-- account erasure (owner + marker) may blank texts and users without a version bump; the FK action of a deleted user
-- may null createdByUserId.
CREATE OR REPLACE FUNCTION public.service_part_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['nameSnapshot', 'skuSnapshot', 'reason', 'note', 'createdByUserId', 'erasedAt'];
  bookkeeping constant text[] := ARRAY['version', 'lastEventKind', 'updatedAt'];
  allowed text[];
  froms "ServicePartState"[];
  tos "ServicePartState"[];
  k "ServicePartEventKind" := NEW."lastEventKind";
  cs "ServiceCaseStatus";
  w record;
BEGIN
  IF in_erasure
     AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
     AND NEW."reason" IS NULL AND NEW."note" IS NULL AND NEW."createdByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL
     AND (CASE WHEN OLD."inventoryItemId" IS NULL
               THEN NEW."nameSnapshot" = 'חלק שנמחק' AND NEW."skuSnapshot" IS NULL
               ELSE NEW."nameSnapshot" = OLD."nameSnapshot" AND NEW."skuSnapshot" IS NOT DISTINCT FROM OLD."skuSnapshot" END) THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1 AND NEW."createdByUserId" IS NULL
     AND (to_jsonb(NEW) - 'createdByUserId') = (to_jsonb(OLD) - 'createdByUserId') THEN
    RETURN NEW;
  END IF;
  SELECT "status" INTO cs FROM "ServiceCase" WHERE "id" = OLD."caseId" AND "businessId" = OLD."businessId" FOR UPDATE;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_VERSION: a change moves the version from %s to %s, not %s', OLD."version", OLD."version" + 1, NEW."version");
  END IF;
  -- kind → allowed columns, allowed from-states, allowed to-states
  CASE k
    WHEN 'RESERVED' THEN allowed := ARRAY['state']; froms := '{NEEDED,ON_ORDER}'; tos := '{RESERVED}';
    WHEN 'RELEASED' THEN allowed := ARRAY['state']; froms := '{RESERVED}'; tos := '{NEEDED}';
    WHEN 'ORDER_LINKED' THEN allowed := ARRAY['state', 'purchaseOrderId', 'purchaseOrderLineId', 'expectedOn']; froms := '{NEEDED}'; tos := '{ON_ORDER}';
    WHEN 'ORDER_UPDATED' THEN allowed := ARRAY['purchaseOrderId', 'purchaseOrderLineId', 'expectedOn']; froms := '{ON_ORDER}'; tos := '{ON_ORDER}';
    WHEN 'ISSUED' THEN allowed := ARRAY['state', 'issueMovementId', 'unitCostAgorot', 'costSource']; froms := '{NEEDED,ON_ORDER,RESERVED}'; tos := '{ISSUED}';
    WHEN 'SENT_WITH_EXTERNAL' THEN allowed := ARRAY['state', 'issueMovementId', 'unitCostAgorot', 'costSource', 'externalWorkId']; froms := '{NEEDED,ON_ORDER,RESERVED,ISSUED}'; tos := '{ISSUED}';
    WHEN 'INSTALLED' THEN allowed := ARRAY['state', 'closedAt']; froms := '{ISSUED}'; tos := '{INSTALLED}';
    WHEN 'RETURNED' THEN allowed := ARRAY['state', 'returnMovementId', 'closedAt']; froms := '{ISSUED}'; tos := '{RETURNED}';
    WHEN 'WRITTEN_OFF' THEN allowed := ARRAY['state', 'writeOffReason', 'note', 'closedAt']; froms := '{ISSUED}'; tos := '{WRITTEN_OFF}';
    WHEN 'BACK_FROM_EXTERNAL' THEN allowed := ARRAY['state', 'returnMovementId', 'writeOffReason', 'note', 'closedAt']; froms := '{ISSUED}'; tos := '{RETURNED,INSTALLED,WRITTEN_OFF}';
    WHEN 'CANCELLED' THEN allowed := ARRAY['state', 'reason', 'closedAt']; froms := '{NEEDED,ON_ORDER,RESERVED}'; tos := '{CANCELLED}';
    WHEN 'SPLIT' THEN allowed := ARRAY['quantity']; froms := '{ISSUED}'; tos := '{ISSUED}';
    WHEN 'PRICE_SET' THEN allowed := ARRAY['customerUnitPriceAgorot']; froms := '{NEEDED,ON_ORDER,RESERVED,ISSUED,INSTALLED}'; tos := froms;
    WHEN 'QUOTED' THEN allowed := ARRAY['quotedInVersion']; froms := '{NEEDED,ON_ORDER,RESERVED,ISSUED,INSTALLED}'; tos := froms;
    WHEN 'COST_CORRECTED' THEN allowed := ARRAY['unitCostAgorot', 'costSource']; froms := '{ISSUED,INSTALLED,WRITTEN_OFF,RETURNED}'; tos := froms;
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_KIND: %s is not a change of an existing line', k);
  END CASE;
  IF NOT (OLD."state" = ANY (froms)) OR NOT (NEW."state" = ANY (tos)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_TRANSITION: %s does not move %s to %s', k, OLD."state", NEW."state");
  END IF;
  IF k IN ('PRICE_SET', 'QUOTED', 'COST_CORRECTED') AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_TRANSITION: %s keeps the state', k);
  END IF;
  IF (to_jsonb(NEW) - allowed - bookkeeping) <> (to_jsonb(OLD) - allowed - bookkeeping) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_CHANGE_NOT_KIND: a %s changes only its own columns', k);
  END IF;
  -- M2‑2: no line is (re)opened on a CLOSED case — the deferred close guard alone cannot see an uncommitted line.
  IF cs = 'CLOSED' AND NEW."state" IN ('NEEDED', 'ON_ORDER', 'RESERVED', 'ISSUED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_CASE_FINISHED: the case is CLOSED';
  END IF;
  -- kind-specific rules
  IF k IN ('ISSUED', 'SENT_WITH_EXTERNAL') AND OLD."state" <> 'ISSUED' THEN
    IF NEW."costSource" IS NULL OR (OLD."source" = 'STOCK') <> (NEW."issueMovementId" IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_ISSUE: an issue captures its cost source, and a stock line its OUT movement';
    END IF;
    IF OLD."source" = 'STOCK' THEN
      PERFORM public.service_part_check_movement(OLD."businessId", OLD."inventoryItemId", NEW."issueMovementId", 'OUT', OLD."quantity");
    END IF;
  END IF;
  IF k = 'ISSUED' AND NEW."externalWorkId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_ISSUE: a send with a supplier work is SENT_WITH_EXTERNAL';
  END IF;
  IF k = 'SENT_WITH_EXTERNAL' THEN
    IF OLD."source" = 'SUPPLIER' OR OLD."externalWorkId" IS NOT NULL OR NEW."externalWorkId" IS NULL
       OR (OLD."state" = 'ISSUED' AND (NEW."issueMovementId" IS DISTINCT FROM OLD."issueMovementId" OR NEW."unitCostAgorot" IS DISTINCT FROM OLD."unitCostAgorot" OR NEW."costSource" IS DISTINCT FROM OLD."costSource")) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_SEND: a business part goes with ONE supplier work, once';
    END IF;
    SELECT "caseId", "state" INTO w FROM "ServiceExternalWork" WHERE "id" = NEW."externalWorkId" AND "businessId" = NEW."businessId" FOR SHARE;
    IF NOT FOUND OR w."caseId" <> OLD."caseId" OR w."state" <> 'AT_SUPPLIER' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_SEND: the supplier work must be of the same case and at the supplier';
    END IF;
  END IF;
  IF k IN ('INSTALLED', 'RETURNED', 'WRITTEN_OFF') AND OLD."externalWorkId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = format('SERVICE_PART_AT_SUPPLIER: a part sent with a supplier work comes back as BACK_FROM_EXTERNAL, not %s', k);
  END IF;
  IF k = 'BACK_FROM_EXTERNAL' AND OLD."externalWorkId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_NOT_AT_SUPPLIER: the part did not go with a supplier work';
  END IF;
  IF k IN ('RETURNED', 'BACK_FROM_EXTERNAL') AND NEW."state" = 'RETURNED' AND OLD."source" = 'STOCK' THEN
    PERFORM public.service_part_check_movement(OLD."businessId", OLD."inventoryItemId", NEW."returnMovementId", 'IN', OLD."quantity");
  END IF;
  IF k = 'WRITTEN_OFF' AND NEW."writeOffReason" = 'KEPT_BY_SUPPLIER' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_WRITE_OFF: KEPT_BY_SUPPLIER is recorded by BACK_FROM_EXTERNAL';
  END IF;
  IF k = 'SPLIT' AND NOT (NEW."quantity" < OLD."quantity" AND OLD."splitFromPartId" IS NULL AND OLD."externalWorkId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_SPLIT: a split keeps a smaller rest on the original line';
  END IF;
  IF k IN ('ORDER_LINKED', 'ORDER_UPDATED') THEN
    IF k = 'ORDER_UPDATED' AND NEW."purchaseOrderId" IS NOT DISTINCT FROM OLD."purchaseOrderId"
       AND NEW."purchaseOrderLineId" IS NOT DISTINCT FROM OLD."purchaseOrderLineId" AND NEW."expectedOn" IS NOT DISTINCT FROM OLD."expectedOn" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_NO_CHANGE: an order update must change something';
    END IF;
    IF OLD."source" = 'SUPPLIER' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_ORDER_INVALID: a supplier part is not ordered by the business';
    END IF;
    PERFORM public.service_part_check_order(NEW."businessId", NEW."purchaseOrderId", NEW."purchaseOrderLineId");
  END IF;
  IF k = 'PRICE_SET' AND NEW."customerUnitPriceAgorot" IS NOT DISTINCT FROM OLD."customerUnitPriceAgorot" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_NO_CHANGE: a price set must change the price';
  END IF;
  IF k = 'QUOTED' AND (NEW."quotedInVersion" IS NULL OR NEW."customerUnitPriceAgorot" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_QUOTED: a part is quoted at its price, in a quote version of the case';
  END IF;
  IF k = 'COST_CORRECTED' AND NOT (OLD."costSource" IS NOT NULL AND NOT OLD."costIncludedInExternal" AND NEW."costSource" = 'MANUAL'
       AND NEW."unitCostAgorot" IS NOT NULL AND NEW."unitCostAgorot" IS DISTINCT FROM OLD."unitCostAgorot") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP04', MESSAGE = 'SERVICE_PART_COST_CORRECTION: a correction sets a new MANUAL cost on a line whose cost was captured';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_guard() FROM PUBLIC;
CREATE TRIGGER "ServicePart_guard" BEFORE UPDATE ON "ServicePart"
  FOR EACH ROW EXECUTE FUNCTION public.service_part_guard();

-- 4.3 No silent change: at COMMIT the line's current version has its event (any erasure keeps the version).
CREATE OR REPLACE FUNCTION public.service_part_has_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  s record;
BEGIN
  SELECT "version", "lastEventKind" INTO s FROM "ServicePart" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ServicePartEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."partId" = NEW."id" AND e."seq" = s."version" AND e."kind" = s."lastEventKind") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZP05',
      MESSAGE = format('SERVICE_PART_SILENT_CHANGE: part %s is at version %s (%s) with no journal event for it', NEW."id", s."version", s."lastEventKind");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_has_event() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServicePart_has_event" AFTER INSERT OR UPDATE ON "ServicePart"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_part_has_event();

-- 4.4 ק‑4: a family (an issued line and its split children) reconciles with its OUT movement at COMMIT:
-- rest + every returned share = the issued quantity.
CREATE OR REPLACE FUNCTION public.service_part_split_reconciles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  root integer := COALESCE(NEW."splitFromPartId", NEW."id");
  r record;
  total double precision;
  delta double precision;
BEGIN
  SELECT "issueMovementId", "quantity" INTO r FROM "ServicePart" WHERE "id" = root AND "businessId" = NEW."businessId";
  IF NOT FOUND OR r."issueMovementId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r."quantity" + COALESCE(sum(s."quantity"), 0) INTO total FROM "ServicePart" s
   WHERE s."businessId" = NEW."businessId" AND s."splitFromPartId" = root;
  SELECT -"quantityDelta" INTO delta FROM "InventoryMovement" WHERE "id" = r."issueMovementId" AND "businessId" = NEW."businessId";
  IF delta IS NULL OR abs(total - delta) > 1e-9 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZP06',
      MESSAGE = format('SERVICE_PART_SPLIT_UNRECONCILED: part %s and its returned shares hold %s, its issue moved %s', root, total, delta);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_split_reconciles() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServicePart_split_reconciles" AFTER INSERT OR UPDATE ON "ServicePart"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_part_split_reconciles();

-- 4.5 The event mirrors the line as this transaction just left it: same case, seq = version, kind = lastEventKind,
-- state and quantity as on the row, the linked movement of an issue / return, the amount of a price / cost kind.
CREATE OR REPLACE FUNCTION public.service_part_event_matches_part()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM "ServicePart" WHERE "id" = NEW."partId" AND "businessId" = NEW."businessId";
  IF NOT FOUND OR s."caseId" <> NEW."caseId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP07', MESSAGE = 'SERVICE_PART_EVENT_PART_INVALID: the event must name a part (and its case) of the same business';
  END IF;
  IF NEW."seq" <> s."version" OR NEW."kind" <> s."lastEventKind" OR NEW."stateAfter" <> s."state"
     OR abs(NEW."quantity" - s."quantity") > 1e-9
     OR (NEW."movementId" IS NOT NULL AND NEW."movementId" IS DISTINCT FROM s."issueMovementId" AND NEW."movementId" IS DISTINCT FROM s."returnMovementId")
     OR (NEW."kind" = 'ISSUED' AND s."source" = 'STOCK' AND NEW."movementId" IS DISTINCT FROM s."issueMovementId")
     OR (NEW."kind" = 'RETURNED' AND s."source" = 'STOCK' AND NEW."movementId" IS DISTINCT FROM s."returnMovementId")
     OR (NEW."kind" = 'PRICE_SET' AND NEW."amountAgorot" IS DISTINCT FROM s."customerUnitPriceAgorot")
     OR (NEW."kind" = 'COST_CORRECTED' AND NEW."amountAgorot" IS DISTINCT FROM s."unitCostAgorot") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZP07',
      MESSAGE = format('SERVICE_PART_EVENT_MISMATCH: event %s seq %s must mirror part version %s (%s)', NEW."kind", NEW."seq", s."version", s."lastEventKind");
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_event_matches_part() FROM PUBLIC;
CREATE TRIGGER "ServicePartEvent_matches_part" BEFORE INSERT ON "ServicePartEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_part_event_matches_part();

-- 4.6 The journal is append-only: no UPDATE but the erasure's scrub (users, digests, reason) and the FK action of a
-- deleted user; no DELETE but the cascade of a deleted business; no TRUNCATE.
CREATE OR REPLACE FUNCTION public.service_part_event_guard()
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
    ERRCODE = 'DZP08',
    MESSAGE = format('SERVICE_PART_EVENT_APPEND_ONLY: %s on %I is refused; the journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServicePartEvent_append_only" BEFORE UPDATE OR DELETE ON "ServicePartEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_part_event_guard();
CREATE TRIGGER "ServicePartEvent_no_truncate" BEFORE TRUNCATE ON "ServicePartEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.7 M2‑2: a case cannot become CLOSED while a part is open (checked at COMMIT). Nothing else about the case is
-- judged: a cancel request (READY + CANCELLED, cancellationRequested) and the existing CANCELLED path are untouched.
CREATE OR REPLACE FUNCTION public.service_case_parts_resolved_on_close()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  s "ServiceCaseStatus";
BEGIN
  SELECT "status" INTO s FROM "ServiceCase" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF FOUND AND s = 'CLOSED' AND EXISTS (SELECT 1 FROM "ServicePart" p
       WHERE p."businessId" = NEW."businessId" AND p."caseId" = NEW."id" AND p."state" IN ('NEEDED', 'ON_ORDER', 'RESERVED', 'ISSUED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP09', MESSAGE = format('SERVICE_CASE_PARTS_OPEN: case %s cannot close while a part is open', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_parts_resolved_on_close() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_parts_resolved_on_close" AFTER UPDATE OF "status" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_parts_resolved_on_close();

-- 4.8 M2‑1: a supplier work cannot be RETURNED while a business part sent with it is still ISSUED (checked at COMMIT,
-- so the return may resolve its parts and close the work in either order inside one transaction).
CREATE OR REPLACE FUNCTION public.service_external_parts_resolved_on_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  st "ServiceExternalWorkState";
BEGIN
  SELECT "state" INTO st FROM "ServiceExternalWork" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF FOUND AND st = 'RETURNED' AND EXISTS (SELECT 1 FROM "ServicePart" p
       WHERE p."businessId" = NEW."businessId" AND p."externalWorkId" = NEW."id" AND p."state" = 'ISSUED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP10', MESSAGE = format('SERVICE_EXTERNAL_PARTS_UNRESOLVED: work %s cannot return while a part sent with it is unresolved', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_external_parts_resolved_on_return() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceExternalWork_parts_resolved_on_return" AFTER UPDATE OF "state" ON "ServiceExternalWork"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_external_parts_resolved_on_return();

-- ── 5. Account erasure: the one SECURITY DEFINER function ───────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZP11, nothing changed) without a context or
-- when that business is not being deleted. Otherwise, for that business only (M2‑3): the name and sku of every line
-- WITHOUT an inventory item (typed by hand: NON_STOCK and supplier parts) → a fixed text / NULL; reason, note and the
-- creating user → NULL; in the journal the acting users, request digests and reasons → NULL; stamps erasedAt.
-- Item names (copied from the inventory), states, quantities, costs, prices, links and times stay. Returns rows touched.
CREATE OR REPLACE FUNCTION public.service_parts_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZP11', MESSAGE = 'SERVICE_PARTS_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP11', MESSAGE = 'SERVICE_PARTS_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_erasure', 'on', true);

  UPDATE public."ServicePart"
     SET "nameSnapshot" = CASE WHEN "inventoryItemId" IS NULL THEN 'חלק שנמחק' ELSE "nameSnapshot" END,
         "skuSnapshot" = CASE WHEN "inventoryItemId" IS NULL THEN NULL ELSE "skuSnapshot" END,
         "reason" = NULL, "note" = NULL, "createdByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServicePartEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL,
         "reason" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_parts_erase_business() FROM PUBLIC;

-- ── 6. Row-level security — per operation, no DELETE policy ─────────────────────────────────────────────────
ALTER TABLE "ServicePart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServicePart" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_part_tenant_select ON "ServicePart" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_part_tenant_insert ON "ServicePart" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_part_tenant_update ON "ServicePart" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServicePartEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServicePartEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_part_event_tenant_select ON "ServicePartEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_part_event_tenant_insert ON "ServicePartEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServicePart", "ServicePartEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServicePart_id_seq", "ServicePartEvent_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServicePart', 'ServicePartEvent', 'ServicePart_id_seq', 'ServicePartEvent_id_seq')
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
GRANT SELECT, INSERT, UPDATE ON "ServicePart" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServicePart_id_seq" TO app_runtime;
GRANT SELECT, INSERT ON "ServicePartEvent" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServicePartEvent_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_parts_erase_business() TO app_runtime;
-- The two checks the guards PERFORM run as the caller (invoker, reads under RLS): the runtime must be able to call them.
GRANT EXECUTE ON FUNCTION public.service_part_check_movement(integer, integer, integer, text, double precision) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_part_check_order(integer, integer, integer) TO app_runtime;
