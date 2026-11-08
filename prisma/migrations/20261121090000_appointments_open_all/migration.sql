-- Appointments (יומן ותורים) — open for every business, existing and new (owner decision 2026-11-08, after the
-- business 9 pilot: every finished feature is open to all businesses until plans and pricing exist).
--
-- Data only: the two rows migration 20261029090000_appointments_foundation seeded OFF are switched ON.
--   * PlatformFeatureDefinition.appointments.defaultEnabled → true (the catalog in code says the same once its
--     application PR ships — until then the code default keeps the calendar closed);
--   * PlatformFeaturePolicy.appointments.globalEnabled → true. emergencyDisabled is left as it is, so the emergency
--     switch and any business override (BusinessFeatureAccess DISABLED) still close the calendar.
-- External booking is NOT touched: its definition and policy rows stay exactly as they are (OFF), and every customer
-- link still needs its own per-business opening. No schema, no privilege, no policy change.
-- Each statement must touch exactly its one row, or the whole migration fails and nothing changes.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'יומן, תורים, עובדים וזמינות לבעל העסק — פתוח לכל העסקים'
   WHERE "key" = 'appointments';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'appointments definition: expected 1 row, found %', n;
  END IF;

  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'appointments';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'appointments policy: expected 1 row, found %', n;
  END IF;
END $$;
