-- Reversal of 20261023090000_accountant_month_close. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted
-- first). It REFUSES while any of the five tables holds a row, or while any business has the
-- accountant_month_close flag overridden: discarding a period, a package, an approval or the trail is a
-- separate, explicit owner decision — never a side effect of a rollback. Stored package objects (R2, the
-- `exports` domain) are not touched by SQL; with no rows there are none to orphan.
-- It removes its own ledger row in the same transaction, so a later release re-applies the migration whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountantPeriod") OR EXISTS (SELECT 1 FROM "AccountantPackage")
     OR EXISTS (SELECT 1 FROM "AccountantRecipient") OR EXISTS (SELECT 1 FROM "AccountantDelivery")
     OR EXISTS (SELECT 1 FROM "AccountantWorkflowEvent")
     OR EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close') THEN
    RAISE EXCEPTION 'accountant rollback refused: rows exist (an owner decision is required first)';
  END IF;
END
$rb$;

DROP TABLE "AccountantWorkflowEvent", "AccountantDelivery", "AccountantRecipient", "AccountantPackage", "AccountantPeriod" CASCADE;
DROP FUNCTION public.accountant_link_resolve(text, text);
DROP FUNCTION public.accountant_delivery_by_provider_message(text, text);
DROP FUNCTION public.accountant_erase_business();
DROP FUNCTION public.accountant_user_same_business();
DROP FUNCTION public.accountant_package_guard();
DROP FUNCTION public.accountant_delivery_insert_guard();
DROP FUNCTION public.accountant_delivery_update_guard();
DROP FUNCTION public.accountant_event_append_only_guard();
DROP FUNCTION public.accountant_event_truncate_guard();
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_month_close';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_month_close';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023090000_accountant_month_close';
COMMIT;
