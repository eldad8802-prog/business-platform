-- Activity packs — migration lab (20261216090000_activity_packs). Run AFTER the migration, as the table owner.
-- Every check RAISEs on failure (ON_ERROR_STOP=1); the last line prints MIGRATION_LAB_OK.
\set ON_ERROR_STOP 1

INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") VALUES (910001, 'lab A', now(), now()), (910002, 'lab B', now(), now())
  ON CONFLICT ("id") DO NOTHING;

-- 1. Shape: the feature is OFF in both places; the table is FORCE RLS; the runtime has exactly SELECT/INSERT/UPDATE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs' AND "defaultEnabled" = false) THEN
    RAISE EXCEPTION 'L1: activity_packs definition missing or not default OFF';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs' AND "globalEnabled" = false AND "emergencyDisabled" = false) THEN
    RAISE EXCEPTION 'L1: activity_packs policy missing or not globally OFF';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"BusinessActivityProfile"'::regclass) THEN
    RAISE EXCEPTION 'L1: BusinessActivityProfile is not FORCE RLS';
  END IF;
  IF NOT has_table_privilege('app_runtime', '"BusinessActivityProfile"', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION 'L1: app_runtime lacks SELECT/INSERT/UPDATE';
  END IF;
  IF has_table_privilege('app_runtime', '"BusinessActivityProfile"', 'DELETE')
     OR has_table_privilege('app_runtime', '"BusinessActivityProfile"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'L1: app_runtime may DELETE or TRUNCATE';
  END IF;
  IF has_table_privilege('public', '"BusinessActivityProfile"', 'SELECT') THEN
    RAISE EXCEPTION 'L1: PUBLIC can read the table';
  END IF;
END $$;

-- 2. Tenant isolation, as the runtime role.
SET ROLE app_runtime;
SELECT set_config('app.current_business_id', '910001', false);
INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt")
  VALUES (910001, 'APPOINTMENTS', ARRAY['INVENTORY'], now());
UPDATE "BusinessActivityProfile" SET "primaryPack" = 'SERVICE', "additionalPacks" = ARRAY['INVENTORY', 'LEADS'], "updatedAt" = now()
  WHERE "businessId" = 910001;

DO $$
DECLARE n int;
BEGIN
  -- another business's row cannot be written
  BEGIN
    INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "updatedAt") VALUES (910002, 'LEADS', now());
    RAISE EXCEPTION 'L2: cross-tenant insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- no delete for the runtime
  BEGIN
    DELETE FROM "BusinessActivityProfile" WHERE "businessId" = 910001;
    RAISE EXCEPTION 'L2: runtime delete succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO n FROM "BusinessActivityProfile";
  IF n <> 1 THEN RAISE EXCEPTION 'L2: business A sees % rows, expected 1', n; END IF;
END $$;

SELECT set_config('app.current_business_id', '910002', false);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "BusinessActivityProfile";
  IF n <> 0 THEN RAISE EXCEPTION 'L2: business B sees business A''s row'; END IF;
  UPDATE "BusinessActivityProfile" SET "primaryPack" = 'ORDERS' WHERE "businessId" = 910001;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'L2: business B updated business A''s row'; END IF;
END $$;

SELECT set_config('app.current_business_id', '', false);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "BusinessActivityProfile";
  IF n <> 0 THEN RAISE EXCEPTION 'L2: no tenant context still reads rows'; END IF;
END $$;

-- 3. Integrity: only the five packs, never the primary twice, no duplicates, at most four additional.
SELECT set_config('app.current_business_id', '910002', false);
DO $$
DECLARE bad text[] := ARRAY[
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "updatedAt") VALUES (910002, 'GYM', now())$q$,
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt") VALUES (910002, 'LEADS', ARRAY['LEADS'], now())$q$,
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt") VALUES (910002, 'LEADS', ARRAY['ORDERS','ORDERS'], now())$q$,
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt") VALUES (910002, 'LEADS', ARRAY['ORDERS','X'], now())$q$,
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt") VALUES (910002, 'LEADS', ARRAY['ORDERS',NULL], now())$q$,
  $q$INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "source", "updatedAt") VALUES (910002, 'LEADS', 'SUGGESTED', now())$q$
];
  s text;
BEGIN
  FOREACH s IN ARRAY bad LOOP
    BEGIN
      EXECUTE s;
      RAISE EXCEPTION 'L3: accepted: %', s;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  -- the largest valid choice
  INSERT INTO "BusinessActivityProfile" ("businessId", "primaryPack", "additionalPacks", "updatedAt")
    VALUES (910002, 'ORDERS', ARRAY['APPOINTMENTS','SERVICE','INVENTORY','LEADS'], now());
END $$;
RESET ROLE;

-- 4. Deleting a business removes its choice (ON DELETE CASCADE) — nothing is left behind.
DELETE FROM "Business" WHERE "id" = 910002;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessActivityProfile" WHERE "businessId" = 910002) THEN
    RAISE EXCEPTION 'L4: the choice survived its business';
  END IF;
END $$;

SELECT 'MIGRATION_LAB_OK' AS result;
