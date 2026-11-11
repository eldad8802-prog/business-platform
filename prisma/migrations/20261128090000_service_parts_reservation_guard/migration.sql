-- ============================================================================================================
-- 20261128090000_service_parts_reservation_guard — Service Desk: the database guarantees that a cancelled service case
-- holds no stock reservation, that no stock is taken for a cancelled case, and that one quantity on hand is not
-- reserved twice. (הגנת מסד נתונים על שמירות חלקים בקריאה שבוטלה.)
--
-- Migration only. Expand-only: two NEW invoker functions and two NEW triggers that only REFUSE. No table, column,
-- type, enum value, index, policy, grant or row is added or changed; no existing function is replaced; nothing is
-- written by any trigger. Inventory and purchasing tables are read, never written; no billing table is named.
--
-- Why REFUSE and not auto-release (the reasoning in full is in the PR):
--   - the release is already the application's, inside the cancel's transaction (part-release.ts, the parts.core RELEASE
--     decision, one RELEASED event per line with the cancel's idempotency key + digest). A trigger that released by
--     itself would be a second writer of the journal with its own actor / key / digest scheme and would hide a missing
--     release instead of failing it;
--   - refusing is idempotent and has no side effect: a refused transaction leaves nothing; a repeated cancel is
--     answered from the case journal before anything runs; a repeated release cannot double (RELEASED is only from
--     RESERVED — the 20261115090000 guard);
--   - what a part already consumed (ISSUED / INSTALLED / RETURNED / WRITTEN_OFF) is never touched: nothing here
--     writes a part, and the existing guard allows RELEASED / CANCELLED only from the states that never left the stock.
--
-- A case is CANCELLED here when outcome = CANCELLED (status CANCELLED, or READY / DELIVERED / CLOSED / ABANDONED after
-- a cancel of a held item) or a cancel is REQUESTED while a supplier has the item (cancellationRequested).
--
--   G1 "ServiceCase_parts_released_on_cancel" — DEFERRED constraint trigger: at COMMIT a cancelled case has no RESERVED
--      part line. The cancel and its release may run in either order inside the one transaction.
--   G2 "ServicePart_takes_stock_on_live_case" — immediate, after the 20261115090000 guard took the CASE row FOR UPDATE:
--      a. a line of a cancelled case cannot become RESERVED, nor leave the stock (NEEDED / ON_ORDER / RESERVED →
--         ISSUED, by ISSUED or SENT_WITH_EXTERNAL). Returns, installs, write-offs, releases, cancels and price / cost
--         records after a cancel are untouched (they resolve parts — owner rule ק‑3);
--      b. a STOCK line becomes RESERVED only while every RESERVED line of that item (this one included) fits in the
--         item's quantity on hand — under the parts module's own per-item advisory lock ('SDRV', the same key
--         parts.service takes), so two reservations of the last units serialise and one is refused. The inventory row
--         is only read, never locked: the till and the inventory module are not slowed. The reservation stays SOFT
--         (M1): a later sale may take the stock; this checks the moment of reserving only.
--
-- Lock order is the existing one: the case row (FOR UPDATE, by the 20261115090000 guard and the service) → the part
-- line → the item advisory lock. Concurrency: a cancel and a reserve / issue of the same case serialise on the case
-- row; whichever commits second sees the first.
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_held integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServicePart"') IS NULL
     OR to_regclass('public."ServicePartEvent"') IS NULL OR to_regclass('public."InventoryItem"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: the Service Desk foundation (20261112090000) or the service parts (20261115090000) is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_part_guard()') IS NULL OR to_regprocedure('public.service_case_parts_resolved_on_close()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ServicePart_guard' AND tgrelid = 'public."ServicePart"'::regclass) THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: the service parts guards (20261115090000) are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name = 'outcome')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name = 'cancellationRequested')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'InventoryItem' AND column_name = 'currentQuantity') THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: a column this migration reads is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_part_takes_stock_guard()') IS NOT NULL
     OR to_regprocedure('public.service_case_parts_released_on_cancel()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('ServicePart_takes_stock_on_live_case', 'ServiceCase_parts_released_on_cancel')) THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: already applied (a function or trigger of this migration exists); nothing was changed';
  END IF;
  -- The guard would refuse the next write of such a case: the rows are released first, by the application (with their
  -- RELEASED events), never by this migration. The preflight counts them (check 9).
  SELECT count(*) INTO v_held FROM public."ServicePart" p JOIN public."ServiceCase" c ON c."id" = p."caseId" AND c."businessId" = p."businessId"
   WHERE p."state" = 'RESERVED' AND (c."outcome"::text = 'CANCELLED' OR c."cancellationRequested");
  IF v_held > 0 THEN
    RAISE EXCEPTION 'SERVICE_PARTS_RESERVATION_GUARD: % part line(s) of a cancelled case are still RESERVED; release them first; nothing was changed', v_held;
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. G1 — at COMMIT, a cancelled case holds no reservation ────────────────────────────────────────────────
CREATE FUNCTION public.service_case_parts_released_on_cancel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  v_held integer;
BEGIN
  SELECT "outcome"::text AS outcome, "cancellationRequested" AS requested INTO c
    FROM "ServiceCase" WHERE "id" = NEW."id" AND "businessId" = NEW."businessId";
  IF NOT FOUND OR NOT (c.outcome IS NOT DISTINCT FROM 'CANCELLED' OR c.requested) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_held FROM "ServicePart" p
   WHERE p."businessId" = NEW."businessId" AND p."caseId" = NEW."id" AND p."state" = 'RESERVED';
  IF v_held > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZP12',
      MESSAGE = format('SERVICE_PART_RESERVED_ON_CANCELLED_CASE: case %s is cancelled while %s part line(s) are still RESERVED; release them in the same transaction', NEW."id", v_held);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_parts_released_on_cancel() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_parts_released_on_cancel" AFTER UPDATE OF "outcome", "cancellationRequested" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."outcome"::text = 'CANCELLED' OR NEW."cancellationRequested")
  EXECUTE FUNCTION public.service_case_parts_released_on_cancel();

-- ── 2. G2 — no stock taken for a cancelled case; a reservation fits in what is on hand ──────────────────────
CREATE FUNCTION public.service_part_takes_stock_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  v_on_hand double precision;
  v_reserved double precision;
BEGIN
  -- The 20261115090000 guard (BEFORE) already holds the case row FOR UPDATE; taking it again is a no-op that keeps
  -- this check under the same lock even if that guard ever let a change through without it.
  SELECT "outcome"::text AS outcome, "cancellationRequested" AS requested INTO c
    FROM "ServiceCase" WHERE "id" = NEW."caseId" AND "businessId" = NEW."businessId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZP12', MESSAGE = 'SERVICE_PART_CASE_INVALID: the part must name a case of the same business';
  END IF;
  IF c.outcome IS NOT DISTINCT FROM 'CANCELLED' OR c.requested THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZP12',
      MESSAGE = format('SERVICE_PART_CASE_CANCELLED: case %s is cancelled; part %s cannot become %s (only resolving its parts is allowed)', NEW."caseId", NEW."id", NEW."state");
  END IF;
  IF NEW."state" = 'RESERVED' AND NEW."inventoryItemId" IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(1396986454, NEW."inventoryItemId"); -- 0x53445256 'SDRV', the key parts.service takes
    SELECT "currentQuantity" INTO v_on_hand FROM "InventoryItem" WHERE "id" = NEW."inventoryItemId" AND "businessId" = NEW."businessId";
    SELECT COALESCE(sum(p."quantity"), 0) INTO v_reserved FROM "ServicePart" p
     WHERE p."businessId" = NEW."businessId" AND p."inventoryItemId" = NEW."inventoryItemId" AND p."state" = 'RESERVED';
    IF v_on_hand IS NULL OR v_reserved > v_on_hand + 1e-9 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZP13',
        MESSAGE = format('SERVICE_PART_OVER_RESERVED: item %s has %s on hand; the reservations of it would hold %s', NEW."inventoryItemId", COALESCE(v_on_hand, 0), v_reserved);
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_part_takes_stock_guard() FROM PUBLIC;
CREATE TRIGGER "ServicePart_takes_stock_on_live_case" AFTER UPDATE OF "state" ON "ServicePart"
  FOR EACH ROW
  WHEN (NEW."state" IN ('RESERVED', 'ISSUED') AND OLD."state" IN ('NEEDED', 'ON_ORDER', 'RESERVED') AND NEW."state" IS DISTINCT FROM OLD."state")
  EXECUTE FUNCTION public.service_part_takes_stock_guard();
