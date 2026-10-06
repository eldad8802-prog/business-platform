-- Payments core / migration 20261016090000_payments_core_connection_config — OWNER-RUN rollback.
--
-- Removes exactly what the migration added, and nothing else. REFUSED while any connection has
-- been configured (a document issuer chosen, or a default set): those are business decisions and
-- rolling back would silently discard them. Run as the migration owner, never by the application.
-- The ledger row is removed too, so `prisma migrate deploy` would apply the migration again.

BEGIN;

DO $$
DECLARE in_use bigint;
BEGIN
  SELECT count(*) INTO in_use FROM "BusinessPaymentConnection"
   WHERE "documentIssuer"::text <> 'NOT_CONFIGURED' OR "isDefault";
  IF in_use > 0 THEN
    RAISE EXCEPTION 'rollback refused: % connection(s) carry a document-issuer or default decision', in_use;
  END IF;
END $$;

DROP INDEX IF EXISTS "BusinessPaymentConnection_one_default_per_business";
ALTER TABLE "BusinessPaymentConnection" DROP COLUMN IF EXISTS "isDefault";
ALTER TABLE "BusinessPaymentConnection" DROP COLUMN IF EXISTS "documentIssuer";
DROP TYPE IF EXISTS "PaymentDocumentIssuer";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016090000_payments_core_connection_config';

COMMIT;
