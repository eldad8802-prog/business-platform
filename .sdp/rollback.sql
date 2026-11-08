-- Reversal of 20261115090000_service_parts. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted first).
-- It REFUSES while either new table holds a row: discarding a part line or its journal is a separate, explicit owner
-- decision (an issued part also has an inventory movement that would lose its explanation). It removes the two
-- refusing triggers it added to "ServiceCase" / "ServiceExternalWork" (nothing else of 1.2a / 1.2b is touched) and its
-- own ledger row, in one transaction, so a later release re-applies it whole. The lab-only M0 simulation (an enum value
-- on "InventoryMovementReason") is not M2's and is not reversed here.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServicePart") OR EXISTS (SELECT 1 FROM "ServicePartEvent") THEN
    RAISE EXCEPTION 'SERVICE_PARTS_ROLLBACK_REFUSED: a part line or its journal holds rows; nothing was changed';
  END IF;
END
$rb$;

DROP TRIGGER "ServiceCase_parts_resolved_on_close" ON "ServiceCase";
DROP TRIGGER "ServiceExternalWork_parts_resolved_on_return" ON "ServiceExternalWork";
DROP TABLE "ServicePartEvent", "ServicePart";
DROP FUNCTION public.service_parts_erase_business(), public.service_external_parts_resolved_on_return(),
              public.service_case_parts_resolved_on_close(), public.service_part_event_guard(),
              public.service_part_event_matches_part(), public.service_part_split_reconciles(),
              public.service_part_has_event(), public.service_part_guard(), public.service_part_insert_guard(),
              public.service_part_check_order(integer, integer, integer),
              public.service_part_check_movement(integer, integer, integer, text, double precision);
DROP TYPE "ServicePartEventKind", "ServicePartWriteOffReason", "ServicePartCostSource", "ServicePartSource", "ServicePartState";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts';
COMMIT;
