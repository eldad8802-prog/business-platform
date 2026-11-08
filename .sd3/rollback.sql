-- Reversal of 20261120090000_service_desk_ui_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted first).
-- It REFUSES while any of the eight new tables holds a row: discarding a terms snapshot, a warranty offer, a photo
-- record, a share or reminder journal or a storage-erasure job is a separate, explicit owner decision (an erasure job
-- may still have objects to delete). It removes only what this migration created — no 1.2a / 1.2b / M2 object is
-- touched; the feature rows are removed only while the flag is still OFF everywhere — and its own ledger row, in one
-- transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceTextVersion") OR EXISTS (SELECT 1 FROM "ServiceSettings")
     OR EXISTS (SELECT 1 FROM "ServiceIntakeTermsSnapshot") OR EXISTS (SELECT 1 FROM "ServiceWarrantyOffer")
     OR EXISTS (SELECT 1 FROM "ServiceIntakePhoto") OR EXISTS (SELECT 1 FROM "ServiceShareEvent")
     OR EXISTS (SELECT 1 FROM "ServicePhoneReminder") OR EXISTS (SELECT 1 FROM "ServiceStorageErasure") THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI_ROLLBACK_REFUSED: a new table holds rows; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk' AND ("globalEnabled" OR "emergencyDisabled"))
     OR EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk') THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI_ROLLBACK_REFUSED: the service_desk flag was changed from its seeded OFF state; nothing was changed';
  END IF;
END
$rb$;

DROP TABLE "ServicePhoneReminder", "ServiceShareEvent", "ServiceIntakePhoto", "ServiceWarrantyOffer", "ServiceIntakeTermsSnapshot",
           "ServiceSettings", "ServiceTextVersion", "ServiceStorageErasure";
DROP FUNCTION public.service_storage_erasure_record_pass(integer, integer, text), public.service_storage_erasure_due(integer),
              public.service_desk_ui_erase_business(), public.service_storage_erasure_guard(), public.service_phone_reminder_guard(),
              public.service_share_event_guard(), public.service_intake_photo_guard(), public.service_warranty_chain_check(),
              public.service_warranty_offer_guard(), public.service_warranty_end(date, integer, "ServiceDurationUnit"),
              public.service_intake_terms_guard(), public.service_settings_guard(), public.service_text_version_guard(),
              public.service_ui_in_erasure(oid), public.service_ui_business_writable(integer);
DROP TYPE "ServiceStorageErasureState", "ServicePhoneReminderOutcome", "ServiceShareChannel", "ServiceShareObjectKind",
          "ServiceReaffirmMethod", "ServiceWarrantyOfferSource", "ServiceWarrantyOfferState", "ServiceDurationUnit",
          "ServiceTextLegalStatus", "ServiceTextKind";
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'service_desk';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation';
COMMIT;
