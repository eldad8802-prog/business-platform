-- Rollback of 20261102080000_document_supplier_link — OWNER-RUN, on a database where nothing was written with it.
--
-- Refuses (and changes nothing) while ANY of these exists:
--   * a row in "DocumentSupplierLink" or "DocumentSupplierLinkEvent" — an owner's decision is never discarded;
--   * an "ExtractedData" row carrying an issuer reading or ownBusinessExcluded = true;
--   * a business override of the document_supplier_linking flag.
-- Otherwise it reverts the migration whole, in one transaction, and removes its ledger row so a re-apply is possible.

BEGIN;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentSupplierLink") OR EXISTS (SELECT 1 FROM "DocumentSupplierLinkEvent") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: document-supplier links or their trail exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExtractedData"
              WHERE "issuerTaxId" IS NOT NULL OR "issuerCheck" IS NOT NULL OR "ownBusinessExcluded") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: issuer readings exist on ExtractedData; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a business override of document_supplier_linking exists; nothing was changed';
  END IF;
END
$do$;

DROP TABLE "DocumentSupplierLinkEvent";
DROP TABLE "DocumentSupplierLink";
DROP FUNCTION public.document_supplier_link_erase_business();
DROP FUNCTION public.document_supplier_link_event_guard();
DROP FUNCTION public.document_supplier_link_user_same_business();

ALTER TABLE "ExtractedData"
  DROP CONSTRAINT "ExtractedData_issuerCheck_shape",
  DROP CONSTRAINT "ExtractedData_issuerCheck",
  DROP CONSTRAINT "ExtractedData_issuerTaxId_together",
  DROP CONSTRAINT "ExtractedData_issuerTaxIdSource",
  DROP CONSTRAINT "ExtractedData_issuerTaxId_shape",
  DROP COLUMN "ownBusinessExcluded",
  DROP COLUMN "issuerCheck",
  DROP COLUMN "issuerTaxIdValid",
  DROP COLUMN "issuerTaxIdSource",
  DROP COLUMN "issuerTaxId";

DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking';

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102080000_document_supplier_link';

COMMIT;
