-- Reversal of 20261113090000_service_external_work. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted first).
-- It REFUSES while either new table holds a row: discarding a supplier work or its journal is a separate, explicit
-- owner decision. It removes the two refusing triggers it added to "ServiceHandover" / "ServiceCase" (nothing else of
-- the foundation is touched) and its own ledger row, in one transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceExternalWork") OR EXISTS (SELECT 1 FROM "ServiceExternalWorkEvent") THEN
    RAISE EXCEPTION 'SERVICE_EXTERNAL_ROLLBACK_REFUSED: a supplier work or its journal holds rows; nothing was changed';
  END IF;
END
$rb$;

DROP TRIGGER "ServiceHandover_no_open_external" ON "ServiceHandover";
DROP TRIGGER "ServiceCase_external_work_closed" ON "ServiceCase";
DROP TABLE "ServiceExternalWorkEvent", "ServiceExternalWork";
DROP FUNCTION public.service_external_erase_business(), public.service_case_external_work_closed(),
              public.service_handover_no_open_external(), public.service_external_event_guard(),
              public.service_external_event_matches_work(), public.service_external_work_has_event(),
              public.service_external_work_guard(), public.service_external_work_insert_guard();
DROP TYPE "ServiceExternalWorkEventKind", "ServiceExternalReturnResult", "ServiceExternalProgress", "ServiceExternalWorkState";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work';
COMMIT;
