-- Monthly accountant workflow + sending from Dubiz — open for every business, existing and new (owner decision
-- 2026-11-01, after the G5 M4 + M5 pilot in business 9: every finished feature is open to all businesses until plans
-- and pricing exist).
--
-- Data only: the four rows migrations 20261027090000_accountant_month_close and 20261109090000_accountant_delivery_
-- permission seeded OFF are switched ON.
--   * PlatformFeatureDefinition.accountant_month_close / accountant_delivery: defaultEnabled → true (the catalog in
--     code says the same once its application PR ships — until then the code default keeps both closed);
--   * PlatformFeaturePolicy.accountant_month_close / accountant_delivery: globalEnabled → true. emergencyDisabled is
--     left as it is, so the emergency switch and any business override (BusinessFeatureAccess DISABLED) still close
--     either feature.
-- No schema, no privilege, no policy change. Nothing is sent: every package still needs the owner's explicit approval
-- (lib/accountant/delivery.service.ts), and sending still needs the master switch ACCOUNTANT_DELIVERY_ENABLED.
-- Each statement must touch exactly its one row, or the whole migration fails and nothing changes.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'הכנה חודשית אוטומטית של חבילת רואה החשבון, התראה בתוך Dubiz, ושליחה לרואה החשבון באישור בעל העסק — פתוח לכל העסקים'
   WHERE "key" = 'accountant_month_close';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'accountant_month_close definition: expected 1 row, found %', n;
  END IF;
  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'accountant_month_close';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'accountant_month_close policy: expected 1 row, found %', n;
  END IF;
  UPDATE "PlatformFeatureDefinition"
     SET "defaultEnabled" = true,
         "description" = 'שליחת החבילה החודשית לרואה החשבון מתוך Dubiz — כל משלוח באישור מפורש של בעל העסק — פתוח לכל העסקים'
   WHERE "key" = 'accountant_delivery';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'accountant_delivery definition: expected 1 row, found %', n;
  END IF;
  UPDATE "PlatformFeaturePolicy"
     SET "globalEnabled" = true,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = 'accountant_delivery';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'accountant_delivery policy: expected 1 row, found %', n;
  END IF;
END $$;
