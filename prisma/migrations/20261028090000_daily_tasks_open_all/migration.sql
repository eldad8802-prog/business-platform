-- Daily Tasks — open for every business, existing and new (owner decision 2026-10-24).
--
-- Data only: the two rows migration 20261018090000_daily_tasks_foundation seeded OFF are switched ON.
--   * PlatformFeatureDefinition.daily_tasks.defaultEnabled → true (the catalog in code says the same);
--   * PlatformFeaturePolicy.daily_tasks.globalEnabled → true. emergencyDisabled is left as it is, so the
--     emergency switch and any business override (BusinessFeatureAccess) still close the feature.
-- No schema, no privilege, no policy change. Each statement must touch exactly its one row, or the whole
-- migration fails and nothing changes.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'משימות אישיות עם מועד, תזכורת והתראה לטלפון — פתוח לכל העסקים'
   WHERE "key" = 'daily_tasks';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'daily_tasks definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'daily_tasks';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'daily_tasks policy: expected 1 row, found %', n;
  END IF;
END $$;
