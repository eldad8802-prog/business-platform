-- Document ↔ supplier linking — open for every business, existing and new (owner decision 2026-10-27, after the
-- business-9 pilot).
--
-- Data only: the two rows migration 20261103090000_document_supplier_link seeded OFF are switched ON.
--   * PlatformFeatureDefinition.document_supplier_linking.defaultEnabled → true (the catalog in code says the same
--     once its application PR ships — until then the code default keeps it closed);
--   * PlatformFeaturePolicy.document_supplier_linking.globalEnabled → true. emergencyDisabled is left as it is, so
--     the emergency switch and any business override (BusinessFeatureAccess DISABLED) still close the feature.
-- No schema, no privilege, no policy change. Nothing is linked: every link still needs a person's decision.
-- Each statement must touch exactly its one row, or the whole migration fails and nothing changes.
--
-- RELEASE ORDER: sorts after 20261105090000_accountant_link_events, the last migration applied in Production
-- (ledger 196, nothing pending on 2026-10-27), so it is the next and only pending migration in name order.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'בחירת ספק במסך בדיקת המסמך, הצעות שיוך באישור המשתמש והצגת המסמכים בתיק הספק — פתוח לכל העסקים'
   WHERE "key" = 'document_supplier_linking';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'document_supplier_linking definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'document_supplier_linking';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'document_supplier_linking policy: expected 1 row, found %', n;
  END IF;
END $$;
