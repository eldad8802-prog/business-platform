-- Reversal of 20261112090000_service_desk_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted first).
-- It REFUSES while any of the seven tables holds a row: discarding a service case, a quote, a handover or a journal
-- is a separate, explicit owner decision — never a side effect of a rollback. It changes no existing table (the
-- migration changed none). It removes its own ledger row in the same transaction, so a later release re-applies the
-- migration whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceCaseNumberSequence") OR EXISTS (SELECT 1 FROM "ServiceDevice")
     OR EXISTS (SELECT 1 FROM "ServiceCase") OR EXISTS (SELECT 1 FROM "ServiceCaseIntake")
     OR EXISTS (SELECT 1 FROM "ServiceQuote") OR EXISTS (SELECT 1 FROM "ServiceCaseEvent")
     OR EXISTS (SELECT 1 FROM "ServiceHandover") THEN
    RAISE EXCEPTION 'SERVICE_DESK_ROLLBACK_REFUSED: a Service table holds rows; nothing was changed';
  END IF;
END
$rb$;

DROP TABLE "ServiceHandover", "ServiceCaseEvent", "ServiceQuote", "ServiceCaseIntake", "ServiceCase",
           "ServiceDevice", "ServiceCaseNumberSequence";
DROP FUNCTION public.service_erase_business(), public.service_handover_guard(), public.service_journal_truncate_guard(),
              public.service_event_append_only_guard(), public.service_event_matches_case(), public.service_quote_guard(),
              public.service_quote_billing_document_guard(), public.service_intake_guard(), public.service_device_guard(),
              public.service_case_opening_guard(), public.service_case_guard(), public.service_user_same_business();
DROP TYPE "ServiceEventType", "ServiceCaseAction", "ServiceActor", "ServiceQuoteApprovalMethod", "ServiceQuoteState",
          "ServiceCoverageDecision", "ServiceCoverageSource", "ServiceOutcome", "ServiceHoldReason", "ServiceCaseStatus",
          "ServiceCaseKind";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation';
COMMIT;
