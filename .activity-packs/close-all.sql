-- ROLLBACK of 20261221200000_activity_packs_open_all — the exact reverse (owner decision only; proven in the lab).
-- Switches activity_packs back OFF for every business except an ENABLED override (business 9). Saved choices
-- (BusinessActivityProfile) are KEPT: with the feature OFF they are never read, and every Home is the pre-packs Home
-- at once. To ship it to Production it becomes its own migration (next free timestamp) through release-migrate.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = false,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'activity_packs';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'activity_packs policy: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = false,
         "description" = 'התאמת מסך הבית, הסרגל והכלים לתחומי הפעילות שבעל העסק בחר — תצוגה בלבד, כבוי כברירת מחדל'
   WHERE "key" = 'activity_packs';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'activity_packs definition: expected 1 row, found %', n;
  END IF;
END $$;
SELECT 'CLOSE_ALL_OK';
