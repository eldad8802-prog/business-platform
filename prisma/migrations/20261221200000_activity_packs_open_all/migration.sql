-- Activity packs (חבילות פעילות) — available to every business, existing and new (DRAFT: waits for the owner's
-- decision after the business 9 pilot, S3 45223111636 19/19).
--
-- Data only: the two rows migration 20261216090000_activity_packs seeded OFF are switched ON.
--   * PlatformFeatureDefinition.activity_packs.defaultEnabled → true (the catalog in code says the same once its
--     application PR ships; the policy row below is what the resolver reads first);
--   * PlatformFeaturePolicy.activity_packs.globalEnabled → true. emergencyDisabled is left as it is, so the emergency
--     switch and any business override (BusinessFeatureAccess DISABLED) still close the feature.
--
-- What "ON" means for a business: Settings → תחומי הפעילות appears, and a business still in its signup flow
-- (BusinessProfile.onboardingCompletedAt IS NULL) is offered the skippable activity screens. The Home, the bar, the "+"
-- sheet and the tools change ONLY after the owner saves a choice (BusinessActivityProfile) — no row is written here,
-- so every existing business keeps exactly the Home it has today. Display only: no permission, plan, price or other
-- feature is touched.
--
-- Business 9 keeps its ENABLED override and its saved choice. No schema, no privilege, no RLS policy change.
-- Sorts after 20261221190000 (applied) and before 20261222090000 (not applied), so it releases alone.
-- Each statement must touch exactly its one row, or the whole migration fails and nothing changes.
-- Rollback (owner decision): .activity-packs/close-all.sql, the exact reverse, proven in the lab.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'התאמת מסך הבית, הסרגל והכלים לתחומי הפעילות שבעל העסק בחר — תצוגה בלבד, פתוח לכל העסקים'
   WHERE "key" = 'activity_packs';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'activity_packs definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'activity_packs';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'activity_packs policy: expected 1 row, found %', n;
  END IF;
END $$;
