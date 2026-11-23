-- Platform subscriptions — migration lab (20261224090000_platform_subscriptions). Run AFTER the migration, as the
-- table owner, on a database whose businesses 920001..920003 existed BEFORE the migration (the backfill must cover them).
-- Every check RAISEs on failure (ON_ERROR_STOP=1); the last line prints MIGRATION_LAB_OK.
\set ON_ERROR_STOP 1

-- 1. Backfill: every business has exactly one row, a tester (the system business internal), exempt, no plan, no trial;
--    one BACKFILL event each. Nobody is a customer, nobody is trialing or limited.
DO $$
DECLARE nb bigint; ns bigint; ne bigint;
BEGIN
  SELECT count(*) INTO nb FROM "Business";
  SELECT count(*) INTO ns FROM "PlatformSubscription";
  SELECT count(*) INTO ne FROM "PlatformSubscriptionEvent" WHERE "kind" = 'BACKFILL';
  IF nb = 0 OR ns <> nb OR ne <> nb THEN RAISE EXCEPTION 'L1: businesses %, rows %, backfill events %', nb, ns, ne; END IF;
  IF EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "accountType" = 'CUSTOMER' OR "status" <> 'EXEMPT' OR "plan" IS NOT NULL
               OR "trialStartedAt" IS NOT NULL OR "trialEndsAt" IS NOT NULL OR "currentPeriodStart" IS NOT NULL
               OR "currentPeriodEnd" IS NOT NULL OR "cancelAtPeriodEnd" OR "source" <> 'BACKFILL' OR "catalogVersion" <> '2026-11-20') THEN
    RAISE EXCEPTION 'L1: a backfilled row is not a plain exempt tester';
  END IF;
  IF (SELECT "accountType" FROM "PlatformSubscription" WHERE "businessId" = 920001) <> 'TESTER'
     OR (SELECT "accountType" FROM "PlatformSubscription" WHERE "businessId" = 920003) <> 'INTERNAL' THEN
    RAISE EXCEPTION 'L1: tester / internal classification wrong';
  END IF;
END $$;

-- 2. Shape: FORCE RLS on both; exact privileges per role; nothing for PUBLIC.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"PlatformSubscription"'::regclass)
     OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"PlatformSubscriptionEvent"'::regclass) THEN
    RAISE EXCEPTION 'L2: a table is not FORCE RLS';
  END IF;
  IF NOT has_table_privilege('app_runtime', '"PlatformSubscription"', 'SELECT') THEN RAISE EXCEPTION 'L2: runtime cannot read its row'; END IF;
  IF has_table_privilege('app_runtime', '"PlatformSubscription"', 'INSERT') OR has_table_privilege('app_runtime', '"PlatformSubscription"', 'UPDATE')
     OR has_table_privilege('app_runtime', '"PlatformSubscription"', 'DELETE') OR has_table_privilege('app_runtime', '"PlatformSubscription"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'L2: runtime may change a subscription';
  END IF;
  IF has_table_privilege('app_runtime', '"PlatformSubscriptionEvent"', 'SELECT') OR has_table_privilege('app_runtime', '"PlatformSubscriptionEvent"', 'INSERT') THEN
    RAISE EXCEPTION 'L2: runtime has access to the log';
  END IF;
  IF NOT has_table_privilege('app_ctlplane', '"PlatformSubscription"', 'SELECT, INSERT')
     OR NOT has_column_privilege('app_ctlplane', '"PlatformSubscription"', 'plan', 'UPDATE')
     OR has_column_privilege('app_ctlplane', '"PlatformSubscription"', 'businessId', 'UPDATE')
     OR has_column_privilege('app_ctlplane', '"PlatformSubscription"', 'createdAt', 'UPDATE')
     OR has_table_privilege('app_ctlplane', '"PlatformSubscription"', 'DELETE') OR has_table_privilege('app_ctlplane', '"PlatformSubscription"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'L2: control-plane privileges on the subscription are not exact';
  END IF;
  IF NOT has_table_privilege('app_ctlplane', '"PlatformSubscriptionEvent"', 'INSERT')
     OR has_table_privilege('app_ctlplane', '"PlatformSubscriptionEvent"', 'SELECT')
     OR has_table_privilege('app_ctlplane', '"PlatformSubscriptionEvent"', 'UPDATE') OR has_table_privilege('app_ctlplane', '"PlatformSubscriptionEvent"', 'DELETE')
     OR has_table_privilege('app_ctlplane', '"PlatformSubscriptionEvent"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'L2: control-plane privileges on the log are not exact';
  END IF;
  IF has_table_privilege('public', '"PlatformSubscription"', 'SELECT') OR has_table_privilege('public', '"PlatformSubscriptionEvent"', 'SELECT') THEN
    RAISE EXCEPTION 'L2: PUBLIC can read';
  END IF;
END $$;

-- 3. Runtime: sees its own row only, can change nothing.
SET ROLE app_runtime;
SELECT set_config('app.current_business_id', '920001', false);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "PlatformSubscription";
  IF n <> 1 THEN RAISE EXCEPTION 'L3: runtime of business A sees % rows, expected 1', n; END IF;
  IF (SELECT "businessId" FROM "PlatformSubscription") <> 920001 THEN RAISE EXCEPTION 'L3: runtime sees another business'; END IF;
  BEGIN
    UPDATE "PlatformSubscription" SET "plan" = 'PREMIUM' WHERE "businessId" = 920001;
    RAISE EXCEPTION 'L3: runtime changed its own plan';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "reason", "catalogVersion")
      VALUES (920001, 'SYSTEM_TRANSITION', 'TESTER', 'EXEMPT', 'forged', '2026-11-20');
    RAISE EXCEPTION 'L3: runtime wrote the log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SELECT set_config('app.current_business_id', '', false);
DO $$
BEGIN
  IF (SELECT count(*) FROM "PlatformSubscription") <> 0 THEN RAISE EXCEPTION 'L3: runtime without a business sees rows'; END IF;
END $$;
RESET ROLE;

-- 4. Control plane: writes only the business named by the GUC; can append to the log, never rewrite it.
SET ROLE app_ctlplane;
SELECT set_config('app.current_business_id', '920001', false);
UPDATE "PlatformSubscription" SET "accountType" = 'CUSTOMER', "status" = 'ACTIVE', "plan" = 'BASIC', "source" = 'ADMIN',
       "updatedByUserId" = 1, "updatedAt" = now() WHERE "businessId" = 920001;
INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "fromAccountType", "toAccountType", "fromStatus", "toStatus", "toPlan",
       "actorUserId", "reason", "catalogVersion")
  VALUES (920001, 'ADMIN_CHANGE', 'TESTER', 'CUSTOMER', 'EXEMPT', 'ACTIVE', 'BASIC', 1, 'lab: manual plan change', '2026-11-20');
DO $$
DECLARE n int;
BEGIN
  -- another business's row: invisible, so an update touches nothing
  UPDATE "PlatformSubscription" SET "plan" = 'PREMIUM' WHERE "businessId" = 920002;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'L4: control plane changed another business (% rows)', n; END IF;
  BEGIN
    INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "actorUserId", "reason", "catalogVersion")
      VALUES (920002, 'ADMIN_CHANGE', 'TESTER', 'EXEMPT', 1, 'cross tenant', '2026-11-20');
    RAISE EXCEPTION 'L4: control plane logged for another business';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "PlatformSubscriptionEvent" SET "reason" = 'rewritten' WHERE "businessId" = 920001;
    RAISE EXCEPTION 'L4: the log was rewritten';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM "PlatformSubscriptionEvent";
    RAISE EXCEPTION 'L4: the control plane read the log back';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM "PlatformSubscription" WHERE "businessId" = 920001;
    RAISE EXCEPTION 'L4: control plane deleted a subscription';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "PlatformSubscription" SET "businessId" = 920002 WHERE "businessId" = 920001;
    RAISE EXCEPTION 'L4: control plane moved a subscription to another business';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
-- one row per business: a second row for the same business is refused
DO $$
BEGIN
  INSERT INTO "PlatformSubscription" ("businessId", "accountType", "status", "catalogVersion", "source", "updatedAt")
    VALUES (920001, 'TESTER', 'EXEMPT', '2026-11-20', 'ADMIN', now());
  RAISE EXCEPTION 'L4: a duplicate subscription was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "businessId" = 920001) <> 2 THEN RAISE EXCEPTION 'L4: the admin change was not logged'; END IF;
  IF (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "businessId" = 920002) <> 1 THEN RAISE EXCEPTION 'L4: another business''s log changed'; END IF;
END $$;

-- 5. Integrity: every impossible shape is refused (as the owner — constraints bind every role).
DO $$
DECLARE bad text;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    $q$UPDATE "PlatformSubscription" SET "status" = 'EXEMPT' WHERE "businessId" = 920001$q$,                               -- customer without lifecycle
    $q$UPDATE "PlatformSubscription" SET "accountType" = 'TESTER' WHERE "businessId" = 920001$q$,                           -- tester with lifecycle
    $q$UPDATE "PlatformSubscription" SET "plan" = NULL WHERE "businessId" = 920001$q$,                                      -- active without plan
    $q$UPDATE "PlatformSubscription" SET "plan" = 'GOLD' WHERE "businessId" = 920001$q$,                                    -- unknown plan
    $q$UPDATE "PlatformSubscription" SET "status" = 'TRIALING', "plan" = NULL WHERE "businessId" = 920001$q$,               -- trial without end
    $q$UPDATE "PlatformSubscription" SET "trialStartedAt" = now(), "trialEndsAt" = now() - interval '1 day' WHERE "businessId" = 920001$q$,
    $q$UPDATE "PlatformSubscription" SET "currentPeriodStart" = now(), "currentPeriodEnd" = now() WHERE "businessId" = 920001$q$,
    $q$UPDATE "PlatformSubscription" SET "catalogVersion" = 'v2' WHERE "businessId" = 920001$q$,
    $q$UPDATE "PlatformSubscription" SET "source" = 'GUESS' WHERE "businessId" = 920001$q$,
    $q$INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "reason", "catalogVersion") VALUES (920001, 'ADMIN_CHANGE', 'TESTER', 'EXEMPT', 'no actor', '2026-11-20')$q$,
    $q$INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "reason", "catalogVersion") VALUES (920001, 'PROVIDER_EVENT', 'CUSTOMER', 'ACTIVE', 'no provider id', '2026-11-20')$q$,
    $q$INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "reason", "catalogVersion") VALUES (920001, 'SYSTEM_TRANSITION', 'CUSTOMER', 'ACTIVE', '  ', '2026-11-20')$q$,
    $q$INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "reason", "catalogVersion") VALUES (920001, 'SYSTEM_TRANSITION', 'CUSTOMER', 'LAPSED', 'bad status', '2026-11-20')$q$,
    $q$UPDATE "PlatformSubscriptionEvent" SET "reason" = 'owner rewrite'$q$                                                -- append-only binds the owner too
  ] LOOP
    BEGIN
      EXECUTE bad;
      RAISE EXCEPTION 'L5: accepted: %', bad;
    EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;
    END;
  END LOOP;
  -- the legal shapes still pass: trial, past due, free limited, cancel at period end
  UPDATE "PlatformSubscription" SET "status" = 'TRIALING', "plan" = NULL, "trialStartedAt" = now(), "trialEndsAt" = now() + interval '30 days' WHERE "businessId" = 920001;
  UPDATE "PlatformSubscription" SET "status" = 'PAST_DUE', "plan" = 'ADVANCED', "cancelAtPeriodEnd" = true WHERE "businessId" = 920001;
  UPDATE "PlatformSubscription" SET "status" = 'FREE_LIMITED', "plan" = NULL WHERE "businessId" = 920001;
END $$;

-- 6. Provider event ids are unique (a webhook delivered twice is one event).
DO $$
BEGIN
  INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "toPlan", "reason", "providerEventId", "catalogVersion")
    VALUES (920001, 'PROVIDER_EVENT', 'CUSTOMER', 'ACTIVE', 'BASIC', 'lab provider event', 'evt_lab_1', '2026-11-20');
  BEGIN
    INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "toPlan", "reason", "providerEventId", "catalogVersion")
      VALUES (920001, 'PROVIDER_EVENT', 'CUSTOMER', 'ACTIVE', 'BASIC', 'lab provider event again', 'evt_lab_1', '2026-11-20');
    RAISE EXCEPTION 'L6: duplicate provider event accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- 7. Cascade: removing a business removes its subscription and its log (nothing orphaned); the others are untouched.
DELETE FROM "Business" WHERE "id" = 920002;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "businessId" = 920002) OR EXISTS (SELECT 1 FROM "PlatformSubscriptionEvent" WHERE "businessId" = 920002) THEN
    RAISE EXCEPTION 'L7: cascade left rows behind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "businessId" = 920001) THEN RAISE EXCEPTION 'L7: cascade removed another business'; END IF;
END $$;

-- 8. A business created AFTER the migration has no record (stage C decides its trial); nothing creates one silently.
INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") VALUES (920004, 'lab D (after)', now(), now());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "businessId" = 920004) THEN RAISE EXCEPTION 'L8: a record appeared for a new business'; END IF;
END $$;

-- Clean the lab rows so the evidence (run next) sees the backfilled state again.
DELETE FROM "Business" WHERE "id" IN (920001, 920004);
SELECT 'MIGRATION_LAB_OK' AS result;
