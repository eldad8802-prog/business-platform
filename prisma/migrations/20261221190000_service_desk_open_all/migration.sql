-- Service Desk (תיקונים ושירות) — open for every business, existing and new (owner decision 2026-11-23, after the
-- business 9 pilot).
--
-- Data only: the two rows migration 20261120090000_service_desk_ui_foundation seeded OFF are switched ON.
--   * PlatformFeatureDefinition.service_desk.defaultEnabled → true (the catalog in code says the same once its
--     application PR ships — until then the code default keeps the module closed for every business without an
--     ENABLED override, so this migration on its own opens nothing new);
--   * PlatformFeaturePolicy.service_desk.globalEnabled → true. emergencyDisabled is left as it is, so the emergency
--     switch and any business override (BusinessFeatureAccess DISABLED) still close the module.
-- Business 9 keeps its ENABLED override. No schema, no privilege, no RLS policy change; no service row is touched.
-- Sorts after 20261221090000 (applied) and before 20261222090000 (not applied), so it releases alone.
-- Each statement must touch exactly its one row, or the whole migration fails and nothing changes.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'קריאות שירות ותיקונים: קבלת מכשיר, טיפול, ספק חיצוני, הצעת מחיר ומסירה — פתוח לכל העסקים'
   WHERE "key" = 'service_desk';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'service_desk definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'service_desk';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'service_desk policy: expected 1 row, found %', n;
  END IF;
END $$;
