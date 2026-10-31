-- Rollback of 20261109090000_accountant_delivery_permission (owner-run). Removes the `accountant_delivery` flag.
-- Refuses while any business override of it exists: a business that was given (or refused) the permission is a
-- decision on record, and removing its flag silently is not a rollback.
BEGIN;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery') THEN
    RAISE EXCEPTION 'ACCOUNTANT_DELIVERY_ROLLBACK_REFUSED: a business override of accountant_delivery exists; nothing was changed';
  END IF;
END
$do$;
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261109090000_accountant_delivery_permission';
COMMIT;
