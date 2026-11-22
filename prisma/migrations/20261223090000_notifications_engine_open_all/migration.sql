-- Notification engine (מנוע התראות) — open for every business, existing and new (owner decision 2026-11-23, after the
-- business 9 pilot and the Android 1.1.1 internal test).
--
-- Data only: the two rows migration 20261211090000_notification_engine_followup seeded OFF are switched ON.
--   * PlatformFeatureDefinition.notifications_engine.defaultEnabled → true (the catalog in code says the same once its
--     application PR ships — until then the code default keeps the engine closed for every business without an
--     ENABLED override, so this migration on its own opens nothing);
--   * PlatformFeaturePolicy.notifications_engine.globalEnabled → true. emergencyDisabled is left as it is, so the
--     emergency switch and any business override (BusinessFeatureAccess DISABLED) still close the engine.
-- The policy trigger of 20261212090000 (notification_engine_policy_changed) fires on the real change of globalEnabled:
-- for a business without an override the effective state is left to the code default (UNKNOWN), so it records
-- nothing; the worker records each business's first ON moment when it observes it (stable clean-start cutover: no
-- push for an event created before that moment). Business 9 keeps its ENABLED override and its existing record.
-- No schema, no privilege, no RLS policy change. Each statement must touch exactly its one row, or the whole migration
-- fails and nothing changes.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'שליחת התראות לטלפון ולדפדפן (דחיפה), סיכום יומי ורישום מכשירים — פתוח לכל העסקים'
   WHERE "key" = 'notifications_engine';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'notifications_engine definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'notifications_engine';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'notifications_engine policy: expected 1 row, found %', n;
  END IF;
END $$;
