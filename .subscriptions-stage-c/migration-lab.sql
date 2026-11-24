-- Subscriptions stage C — migration lab (20261228090000_subscriptions_stage_c). Run AFTER the migration, as the
-- migration owner, on a database with businesses 930001..930004 and users 930101 (PLATFORM_ADMIN, business 930001)
-- and 930102 (ordinary, business 930001). 930001 is a backfilled TESTER (stage B); the lab writes the other records.
-- Every check RAISEs on failure (ON_ERROR_STOP=1); the last line prints MIGRATION_LAB_OK.
\set ON_ERROR_STOP 1

-- 1. Shape: seven tables; FORCE RLS on the five tenant tables; per-command policies only; the opening matrix.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    AND relname IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest', 'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent',
                    'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent');
  IF n <> 7 THEN RAISE EXCEPTION 'L1: % of 7 tables', n; END IF;
  IF (SELECT count(*) FROM "PlatformUsageMetricMode" WHERE "mode" = 'SHADOW') <> 8 OR (SELECT count(*) FROM "PlatformUsageMetricMode") <> 8 THEN
    RAISE EXCEPTION 'L1: the eight quota metrics are not all SHADOW';
  END IF;
  SELECT count(*) INTO n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relrowsecurity AND relforcerowsecurity
    AND relname IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest', 'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent');
  IF n <> 5 THEN RAISE EXCEPTION 'L1: % of 5 tenant tables are FORCE RLS', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE cmd = 'ALL' AND tablename IN ('PlatformTrialClaim', 'PlatformSubscriptionRequest',
             'BusinessQuotaAdjustment', 'BusinessUsageCounter', 'BusinessUsageEvent', 'PlatformSubscription', 'PlatformSubscriptionEvent')) THEN
    RAISE EXCEPTION 'L1: a FOR ALL policy exists';
  END IF;
  IF (SELECT count(*) FROM "PlatformQuotaPolicy") <> 40 OR (SELECT count(*) FROM "PlatformQuotaPolicyEvent") <> 40 THEN
    RAISE EXCEPTION 'L1: the opening matrix is not 40 rows with 40 history rows';
  END IF;
  IF (SELECT "quota" FROM "PlatformQuotaPolicy" WHERE "metric" = 'ocr_pages' AND "tier" = 'ADVANCED') <> 1000
     OR (SELECT "quota" FROM "PlatformQuotaPolicy" WHERE "metric" = 'storage_customer_bytes' AND "tier" = 'BASIC') <> 5368709120
     OR (SELECT "quota" FROM "PlatformQuotaPolicy" WHERE "metric" = 'ai_owner_actions' AND "tier" = 'PREMIUM') <> 300
     OR (SELECT max("quota") FROM "PlatformQuotaPolicy" WHERE "metric" = 'video_renders') <> 0 THEN
    RAISE EXCEPTION 'L1: an opening matrix value is wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "source" = 'SIGNUP' OR "status" = 'TRIALING') THEN
    RAISE EXCEPTION 'L1: the migration wrote a subscription';
  END IF;
END $$;

-- 2. Privileges: nobody but the definer functions writes counters, the ledger, claims, policy or adjustments.
DO $$
DECLARE t text; p text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PlatformTrialClaim', 'PlatformQuotaPolicy', 'PlatformQuotaPolicyEvent', 'BusinessQuotaAdjustment', 'PlatformUsageMetricMode',
                           'BusinessUsageCounter', 'BusinessUsageEvent'] LOOP
    FOREACH r IN ARRAY ARRAY['app_runtime', 'app_auth', 'app_admin', 'app_ctlplane'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, format('%I', t), p) THEN RAISE EXCEPTION 'L2: % holds % on %', r, p, t; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF has_table_privilege('app_runtime', '"PlatformSubscriptionRequest"', 'UPDATE') OR has_table_privilege('app_runtime', '"PlatformSubscriptionRequest"', 'DELETE') THEN
    RAISE EXCEPTION 'L2: runtime may change a request';
  END IF;
  IF has_table_privilege('app_admin', '"PlatformSubscriptionRequest"', 'INSERT') OR has_table_privilege('app_admin', '"PlatformSubscription"', 'UPDATE') THEN
    RAISE EXCEPTION 'L2: admin may write a table directly';
  END IF;
  IF has_function_privilege('app_runtime', 'public.subscription_signup_open(integer, jsonb, integer, integer, text)', 'EXECUTE')
     OR has_function_privilege('app_auth', 'public.usage_consume(text, text, bigint, text, boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('app_runtime', 'public.quota_policy_set(integer, text, text, bigint, text)', 'EXECUTE')
     OR has_function_privilege('app_runtime', 'public.usage_quota_context(integer, text)', 'EXECUTE')
     OR has_function_privilege('app_admin', 'public.usage_consume(text, text, bigint, text, boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('public', 'public.usage_consume(text, text, bigint, text, boolean, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'L2: a function is executable by the wrong role';
  END IF;
END $$;

-- Records for the lab: 930002 a customer in a trial, 930003 a paying BASIC customer with a current period; 930004 opens
-- through signup in step 9 (the stage B backfill made all of them testers: those rows are replaced here, as the owner).
DELETE FROM "PlatformSubscription" WHERE "businessId" IN (930002, 930003, 930004);
INSERT INTO "PlatformSubscription" ("businessId", "accountType", "status", "plan", "catalogVersion", "trialStartedAt", "trialEndsAt", "source", "updatedAt")
VALUES (930002, 'CUSTOMER', 'TRIALING', NULL, '2026-11-20', now() AT TIME ZONE 'UTC', (now() AT TIME ZONE 'UTC') + interval '30 days', 'ADMIN', now());
INSERT INTO "PlatformSubscription" ("businessId", "accountType", "status", "plan", "catalogVersion", "currentPeriodStart", "currentPeriodEnd", "source", "updatedAt")
VALUES (930003, 'CUSTOMER', 'ACTIVE', 'BASIC', '2026-11-20', (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') + interval '27 days', 'ADMIN', now());

-- 3. Runtime: a tester is measured, never limited; the same unit is counted once; it sees only its own business.
SET ROLE app_runtime;
SELECT set_config('app.current_business_id', '930001', false);
DO $$
DECLARE r record; n int;
BEGIN
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'doc:1', 5, 'lab.ocr', false, true);
  IF r.outcome <> 'COUNTED' OR r.verdict <> 'UNLIMITED' OR r.quota IS NOT NULL OR r.used <> 5 OR r.account_type <> 'TESTER' THEN
    RAISE EXCEPTION 'L3: tester consume %', row_to_json(r);
  END IF;
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'doc:1', 5, 'lab.ocr', false, true);
  IF r.outcome <> 'DUPLICATE' OR r.used <> 5 THEN RAISE EXCEPTION 'L3: a retry was counted again %', row_to_json(r); END IF;
  -- far beyond every plan's quota, enforce = true: a tester is still never refused
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'doc:2', 100000, 'lab.ocr', false, true);
  IF r.outcome <> 'COUNTED' THEN RAISE EXCEPTION 'L3: a tester was refused'; END IF;
  IF (SELECT period_key FROM public.usage_quota_snapshot('ocr_pages')) !~ '^m:[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'L3: tester period is not the month'; END IF;
  SELECT count(*) INTO n FROM "BusinessUsageEvent";
  IF n <> 2 THEN RAISE EXCEPTION 'L3: runtime sees % units, expected its own 2', n; END IF;
  SELECT count(*) INTO n FROM "PlatformTrialClaim";
  IF n <> 0 THEN RAISE EXCEPTION 'L3: runtime sees trial claims'; END IF;
  BEGIN
    INSERT INTO "BusinessUsageCounter" ("businessId", "metric", "periodKey", "used") VALUES (930001, 'ocr_pages', 'ALL', 0);
    RAISE EXCEPTION 'L3: runtime wrote a counter directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE "BusinessUsageCounter" SET "used" = 0;
    RAISE EXCEPTION 'L3: runtime reset its counter';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.usage_consume('Bad Metric', 'x', 1, 'lab', false, false);
    RAISE EXCEPTION 'L3: a bad metric was accepted';
  EXCEPTION WHEN SQLSTATE 'DZQ02' THEN NULL;
  END;
END $$;
SELECT set_config('app.current_business_id', '', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.usage_consume('ocr_pages', 'doc:9', 1, 'lab.ocr', false, false);
    RAISE EXCEPTION 'L3: consume without a business context';
  EXCEPTION WHEN SQLSTATE 'DZQ01' THEN NULL;
  END;
  IF (SELECT count(*) FROM "BusinessUsageCounter") <> 0 THEN RAISE EXCEPTION 'L3: runtime without a business sees counters'; END IF;
END $$;

-- 4. A trialing customer: the TRIAL quota over the trial period; shadow records OVER_SHADOW, enforce refuses.
SELECT set_config('app.current_business_id', '930002', false);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.usage_consume('business_documents', 'bd:1', 49, 'lab.docs', false, true);
  IF r.outcome <> 'COUNTED' OR r.quota <> 50 OR r.verdict <> 'WITHIN' OR r.period_key !~ '^t:' THEN RAISE EXCEPTION 'L4: trial consume %', row_to_json(r); END IF;
  SELECT * INTO r FROM public.usage_consume('business_documents', 'bd:2', 1, 'lab.docs', false, true);
  IF r.outcome <> 'COUNTED' OR r.used <> 50 THEN RAISE EXCEPTION 'L4: the last unit %', row_to_json(r); END IF;
  SELECT * INTO r FROM public.usage_consume('business_documents', 'bd:3', 1, 'lab.docs', false, true);
  IF r.outcome <> 'DENIED' OR r.used <> 50 THEN RAISE EXCEPTION 'L4: enforce did not refuse %', row_to_json(r); END IF;
  IF EXISTS (SELECT 1 FROM "BusinessUsageEvent" WHERE "unitKey" = 'bd:3') THEN RAISE EXCEPTION 'L4: a refused unit was recorded'; END IF;
  SELECT * INTO r FROM public.usage_consume('business_documents', 'bd:3', 1, 'lab.docs', false, false);
  IF r.outcome <> 'COUNTED' OR r.verdict <> 'OVER_SHADOW' OR r.used <> 51 THEN RAISE EXCEPTION 'L4: shadow %', row_to_json(r); END IF;
  -- video is 0 for a trial: the first unit is over
  SELECT * INTO r FROM public.usage_consume('video_renders', 'v:1', 1, 'lab.video', false, true);
  IF r.outcome <> 'DENIED' THEN RAISE EXCEPTION 'L4: video was allowed in a trial'; END IF;
  -- a measured-only metric (no policy row) is never limited
  SELECT * INTO r FROM public.usage_consume('ocr_provider_units', 'a:1', 7, 'lab.ocr', false, true);
  IF r.outcome <> 'COUNTED' OR r.verdict <> 'UNLIMITED' THEN RAISE EXCEPTION 'L4: measured-only %', row_to_json(r); END IF;
END $$;

-- 5. Reserve / settle: a provider call reserves; RELEASED gives the unit back; UNKNOWN keeps it counted.
DO $$
DECLARE r record; s text;
BEGIN
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'p:1', 3, 'lab.ocr', true, true);
  IF r.outcome <> 'COUNTED' OR r.used <> 3 THEN RAISE EXCEPTION 'L5: reserve %', row_to_json(r); END IF;
  IF (SELECT "state" FROM "BusinessUsageEvent" WHERE "unitKey" = 'p:1') <> 'RESERVED' THEN RAISE EXCEPTION 'L5: not RESERVED'; END IF;
  s := public.usage_settle('ocr_pages', 'p:1', 'RELEASED');
  IF s <> 'RELEASED' OR (SELECT used FROM public.usage_quota_snapshot('ocr_pages')) <> 0 THEN RAISE EXCEPTION 'L5: release did not give back'; END IF;
  IF public.usage_settle('ocr_pages', 'p:1', 'RELEASED') <> 'NOOP' THEN RAISE EXCEPTION 'L5: released twice'; END IF;
  IF public.usage_settle('ocr_pages', 'p:1', 'COUNTED') <> 'NOOP' THEN RAISE EXCEPTION 'L5: a released unit came back'; END IF;
  -- the same unit key cannot be consumed again after release (it is the same unit): DUPLICATE
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'p:1', 3, 'lab.ocr', true, true);
  IF r.outcome <> 'DUPLICATE' THEN RAISE EXCEPTION 'L5: a released unit was recounted'; END IF;
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'p:2', 4, 'lab.ocr', true, true);
  IF public.usage_settle('ocr_pages', 'p:2', 'UNKNOWN') <> 'UNKNOWN' OR (SELECT used FROM public.usage_quota_snapshot('ocr_pages')) <> 4 THEN
    RAISE EXCEPTION 'L5: UNKNOWN must stay counted';
  END IF;
  IF public.usage_settle('ocr_pages', 'p:2', 'COUNTED') <> 'COUNTED' THEN RAISE EXCEPTION 'L5: reconcile UNKNOWN -> COUNTED'; END IF;
  IF public.usage_settle('ocr_pages', 'nope', 'RELEASED') <> 'NOOP' THEN RAISE EXCEPTION 'L5: unknown unit'; END IF;
  -- storage is cumulative (ALL) and a deleted file gives its bytes back
  SELECT * INTO r FROM public.usage_consume('storage_customer_bytes', 'f:1', 1000, 'lab.upload', false, true);
  IF r.period_key <> 'ALL' OR r.quota <> 1073741824 THEN RAISE EXCEPTION 'L5: storage %', row_to_json(r); END IF;
  s := public.usage_settle('storage_customer_bytes', 'f:1', 'RELEASED');
  IF s <> 'RELEASED' OR (SELECT used FROM public.usage_quota_snapshot('storage_customer_bytes')) <> 0 THEN
    RAISE EXCEPTION 'L5: storage release';
  END IF;
  -- alerts: each threshold once, never downwards
  PERFORM public.usage_consume('accountant_emails', 'e:1', 1, 'lab.mail', false, false);
  IF NOT public.usage_mark_alert('accountant_emails', (SELECT period_key FROM public.usage_quota_snapshot('accountant_emails')), 80) THEN RAISE EXCEPTION 'L5: first 80 alert'; END IF;
  IF public.usage_mark_alert('accountant_emails', (SELECT period_key FROM public.usage_quota_snapshot('accountant_emails')), 80) THEN RAISE EXCEPTION 'L5: 80 alerted twice'; END IF;
  IF NOT public.usage_mark_alert('accountant_emails', (SELECT period_key FROM public.usage_quota_snapshot('accountant_emails')), 100) THEN RAISE EXCEPTION 'L5: 100 alert'; END IF;
  IF public.usage_mark_alert('accountant_emails', (SELECT period_key FROM public.usage_quota_snapshot('accountant_emails')), 90) THEN RAISE EXCEPTION 'L5: alert went down'; END IF;
END $$;

-- 6. A paying BASIC customer: its own period, the BASIC quota; it cannot touch another business's units.
SELECT set_config('app.current_business_id', '930003', false);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.usage_consume('ocr_pages', 'doc:1', 1, 'lab.ocr', false, true);
  IF r.quota <> 300 OR r.period_key !~ '^p:' THEN RAISE EXCEPTION 'L6: paid period %', row_to_json(r); END IF;
  IF public.usage_settle('business_documents', 'bd:1', 'RELEASED') <> 'NOOP' THEN RAISE EXCEPTION 'L6: settled another business''s unit'; END IF;
  IF (SELECT count(*) FROM "BusinessUsageEvent" WHERE "businessId" <> 930003) <> 0 THEN RAISE EXCEPTION 'L6: sees other businesses'; END IF;
  -- requests: its own business only; one open request per subject
  INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "requestedPlan", "createdByUserId") VALUES (930003, 'PLAN', 'ADVANCED', 930102);
  BEGIN
    INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "requestedPlan") VALUES (930003, 'PLAN', 'ADVANCED');
    RAISE EXCEPTION 'L6: a second open request was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "requestedPlan") VALUES (930002, 'PLAN', 'PREMIUM');
    RAISE EXCEPTION 'L6: a request for another business was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "requestedPlan", "status", "handledAt", "handledByUserId") VALUES (930003, 'PLAN', 'PREMIUM', 'HANDLED', now(), 1);
    RAISE EXCEPTION 'L6: a self-handled request was accepted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  INSERT INTO "PlatformSubscriptionRequest" ("businessId", "kind", "metric", "note") VALUES (930003, 'QUOTA', 'ocr_pages', 'need more scans');
  -- runtime cannot call the admin writers or the signup writer
  BEGIN
    PERFORM public.quota_policy_set(930101, 'ocr_pages', 'BASIC', 999999, 'forged');
    RAISE EXCEPTION 'L6: runtime changed a policy';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- the expiry recorder is runtime-callable and harmless when nothing is due
  IF public.subscription_expire_due_trials(10) <> 0 THEN RAISE EXCEPTION 'L6: expired a trial that is not due'; END IF;
END $$;
SELECT set_config('app.current_business_id', '', false);
RESET ROLE;

-- 7. Admin writers (as app_admin): a PLATFORM_ADMIN only; every write leaves an audit row.
SET ROLE app_admin;
DO $$
DECLARE v_id bigint; c record; n_before bigint;
BEGIN
  n_before := (SELECT count(*) FROM "PlatformAuditEvent");
  BEGIN
    PERFORM public.quota_policy_set(930102, 'ocr_pages', 'BASIC', 400, 'not an admin');
    RAISE EXCEPTION 'L7: an ordinary user changed a policy';
  EXCEPTION WHEN SQLSTATE 'DZQ10' THEN NULL;
  END;
  BEGIN
    PERFORM public.quota_policy_set(930101, 'ocr_pages', 'BASIC', 400, '  ');
    RAISE EXCEPTION 'L7: a policy change without a reason';
  EXCEPTION WHEN SQLSTATE 'DZQ02' THEN NULL;
  END;
  BEGIN
    PERFORM public.quota_policy_set(930101, 'ocr_pages', 'BASIC', 5000000, 'typing slip');
    RAISE EXCEPTION 'L7: a quota above the ceiling';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.quota_policy_set(930101, 'ocr_pages', 'BASIC', 400, 'lab: raise Basic OCR');
  SELECT * INTO c FROM public.usage_quota_context(930003, 'ocr_pages');
  IF c.o_quota <> 400 THEN RAISE EXCEPTION 'L7: new policy not applied (%)', c.o_quota; END IF;
  v_id := public.quota_adjustment_add(930101, 930003, 'ocr_pages', 'ADD', 50, NULL, 'lab: goodwill');
  SELECT * INTO c FROM public.usage_quota_context(930003, 'ocr_pages');
  IF c.o_quota <> 450 THEN RAISE EXCEPTION 'L7: ADD not applied (%)', c.o_quota; END IF;
  PERFORM public.quota_adjustment_add(930101, 930003, 'ocr_pages', 'OVERRIDE', 2000, NULL, 'lab: special quota');
  SELECT * INTO c FROM public.usage_quota_context(930003, 'ocr_pages');
  IF c.o_quota <> 2050 THEN RAISE EXCEPTION 'L7: OVERRIDE + ADD not applied (%)', c.o_quota; END IF;
  IF NOT public.quota_adjustment_revoke(930101, v_id, 'lab: done') THEN RAISE EXCEPTION 'L7: revoke'; END IF;
  IF public.quota_adjustment_revoke(930101, v_id, 'lab: again') THEN RAISE EXCEPTION 'L7: revoked twice'; END IF;
  SELECT * INTO c FROM public.usage_quota_context(930003, 'ocr_pages');
  IF c.o_quota <> 2000 THEN RAISE EXCEPTION 'L7: revoke not applied (%)', c.o_quota; END IF;
  -- requests
  IF NOT public.subscription_request_resolve(930101, (SELECT min("id") FROM "PlatformSubscriptionRequest"), 'HANDLED', 'assigned ADVANCED') THEN
    RAISE EXCEPTION 'L7: resolve';
  END IF;
  -- activation mode: admin-managed, audited; setting the same mode again changes nothing
  IF NOT public.usage_metric_mode_set(930101, 'video_renders', 'ENFORCE', 'lab: enforce video') THEN RAISE EXCEPTION 'L7: mode set'; END IF;
  IF public.usage_metric_mode_set(930101, 'video_renders', 'ENFORCE', 'lab: again') THEN RAISE EXCEPTION 'L7: same mode audited twice'; END IF;
  BEGIN
    PERFORM public.usage_metric_mode_set(930101, 'video_renders', 'ON', 'lab: bad mode');
    RAISE EXCEPTION 'L7: a bad mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM "PlatformAuditEvent") - n_before <> 6 THEN
    RAISE EXCEPTION 'L7: % audit rows, expected 6', (SELECT count(*) FROM "PlatformAuditEvent") - n_before;
  END IF;
  IF (SELECT count(*) FROM "PlatformQuotaPolicyEvent" WHERE "actorUserId" = 930101) <> 1 THEN RAISE EXCEPTION 'L7: policy history'; END IF;
  -- the console reads across businesses, never writes
  IF (SELECT count(*) FROM "BusinessUsageEvent") < 3 OR (SELECT count(*) FROM "PlatformSubscription") < 3 THEN RAISE EXCEPTION 'L7: admin read'; END IF;
  BEGIN
    UPDATE "PlatformQuotaPolicy" SET "quota" = 0;
    RAISE EXCEPTION 'L7: admin wrote the policy directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
-- an adjustment counts only inside its window (separate transactions: now() is the transaction's time)
SELECT public.quota_adjustment_add(930101, 930003, 'accountant_emails', 'ADD', 5, (now() AT TIME ZONE 'UTC') + interval '1 second', 'lab: short') > 0 AS added;
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public.usage_quota_context(930003, 'accountant_emails');
  IF c.o_quota <> 10 THEN RAISE EXCEPTION 'L7: an active adjustment does not count (%)', c.o_quota; END IF;
END $$;
SELECT pg_sleep(1.5);
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public.usage_quota_context(930003, 'accountant_emails');
  IF c.o_quota <> 5 THEN RAISE EXCEPTION 'L7: an expired adjustment still counts (%)', c.o_quota; END IF;
END $$;
RESET ROLE;

-- 8. History is append-only, for the owner too.
DO $$
BEGIN
  BEGIN
    UPDATE "PlatformQuotaPolicyEvent" SET "reason" = 'rewritten';
    RAISE EXCEPTION 'L8: policy history rewritten';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 9. Signup (as app_auth): a first identity opens a 30-day trial; the same tax id, email or Google subject again opens
--    WITHOUT a trial; a phone match alone is only a hint; a business that already has a record is refused.
SET ROLE app_auth;
DO $$
DECLARE o text;
  d_tax text := repeat('a', 64); d_mail text := repeat('b', 64); d_phone text := repeat('c', 64); d_mail2 text := repeat('d', 64);
BEGIN
  o := public.subscription_signup_open(930004, jsonb_build_array(jsonb_build_object('kind', 'TAX_ID', 'digest', d_tax),
         jsonb_build_object('kind', 'EMAIL', 'digest', d_mail), jsonb_build_object('kind', 'PHONE', 'digest', d_phone)), 1, 30, '2026-11-20');
  IF o <> 'TRIAL_OPENED' THEN RAISE EXCEPTION 'L9: first signup %', o; END IF;
  BEGIN
    PERFORM public.subscription_signup_open(930004, jsonb_build_array(jsonb_build_object('kind', 'EMAIL', 'digest', d_mail2)), 1, 30, '2026-11-20');
    RAISE EXCEPTION 'L9: a second record for the same business';
  EXCEPTION WHEN SQLSTATE 'DZS02' THEN NULL;
  END;
  BEGIN
    PERFORM public.usage_consume('ocr_pages', 'x', 1, 'lab', false, false);
    RAISE EXCEPTION 'L9: the auth plane counted usage';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") VALUES (930005, 'lab E', now(), now()), (930006, 'lab F', now(), now()), (930007, 'lab G', now(), now());
SET ROLE app_auth;
DO $$
DECLARE o text;
BEGIN
  o := public.subscription_signup_open(930005, jsonb_build_array(jsonb_build_object('kind', 'TAX_ID', 'digest', repeat('a', 64)),
         jsonb_build_object('kind', 'EMAIL', 'digest', repeat('e', 64))), 1, 30, '2026-11-20');
  IF o <> 'DUPLICATE_NO_TRIAL' THEN RAISE EXCEPTION 'L9: same tax id %', o; END IF;
  o := public.subscription_signup_open(930006, jsonb_build_array(jsonb_build_object('kind', 'EMAIL', 'digest', repeat('f', 64)),
         jsonb_build_object('kind', 'PHONE', 'digest', repeat('c', 64))), 1, 30, '2026-11-20');
  IF o <> 'TRIAL_OPENED_PHONE_HINT' THEN RAISE EXCEPTION 'L9: phone-only match %', o; END IF;
  -- a claim under another key version does not match (rotation starts a new space, by design)
  o := public.subscription_signup_open(930007, jsonb_build_array(jsonb_build_object('kind', 'TAX_ID', 'digest', repeat('a', 64))), 2, 30, '2026-11-20');
  IF o <> 'TRIAL_OPENED' THEN RAISE EXCEPTION 'L9: key version %', o; END IF;
  BEGIN
    PERFORM public.subscription_signup_open(930007, '[]'::jsonb, 1, 30, '2026-11-20');
    RAISE EXCEPTION 'L9: empty claims';
  EXCEPTION WHEN SQLSTATE 'DZS02' OR SQLSTATE 'DZS03' THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT "status" FROM "PlatformSubscription" WHERE "businessId" = 930004) <> 'TRIALING'
     OR (SELECT "trialEndsAt" - "trialStartedAt" FROM "PlatformSubscription" WHERE "businessId" = 930004) <> interval '30 days'
     OR (SELECT "status" FROM "PlatformSubscription" WHERE "businessId" = 930005) <> 'FREE_LIMITED'
     OR (SELECT "trialStartedAt" FROM "PlatformSubscription" WHERE "businessId" = 930005) IS NOT NULL THEN
    RAISE EXCEPTION 'L9: signup records wrong';
  END IF;
  IF (SELECT count(*) FROM "PlatformTrialClaim" WHERE "businessId" = 930005 AND "outcome" = 'DUPLICATE_DETECTED') <> 2 THEN RAISE EXCEPTION 'L9: duplicate claims'; END IF;
  IF (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "businessId" IN (930004, 930005, 930006, 930007) AND "kind" = 'SYSTEM_TRANSITION') <> 4 THEN
    RAISE EXCEPTION 'L9: signup events';
  END IF;
  -- claims are history: their identity columns are never rewritten
  BEGIN
    UPDATE "PlatformTrialClaim" SET "digest" = repeat('0', 64) WHERE "businessId" = 930004;
    RAISE EXCEPTION 'L9: a claim was rewritten';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 10. Trial end: the context limits at once; the recorder writes the transition and its log, once.
UPDATE "PlatformSubscription" SET "trialStartedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days', "trialEndsAt" = (now() AT TIME ZONE 'UTC') - interval '1 day'
 WHERE "businessId" = 930004;
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public.usage_quota_context(930004, 'business_documents');
  IF c.o_tier <> 'FREE_LIMITED' OR c.o_quota <> 0 THEN RAISE EXCEPTION 'L10: an ended trial is not limited (% %)', c.o_tier, c.o_quota; END IF;
END $$;
SET ROLE app_runtime;
DO $$
BEGIN
  IF public.subscription_expire_due_trials(10) <> 1 THEN RAISE EXCEPTION 'L10: expiry did not record'; END IF;
  IF public.subscription_expire_due_trials(10) <> 0 THEN RAISE EXCEPTION 'L10: expiry recorded twice'; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT "status" FROM "PlatformSubscription" WHERE "businessId" = 930004) <> 'FREE_LIMITED' THEN RAISE EXCEPTION 'L10: status'; END IF;
  IF (SELECT count(*) FROM "PlatformSubscriptionEvent" WHERE "businessId" = 930004 AND "fromStatus" = 'TRIALING' AND "toStatus" = 'FREE_LIMITED') <> 1 THEN
    RAISE EXCEPTION 'L10: transition log';
  END IF;
  IF (SELECT "status" FROM "PlatformSubscription" WHERE "businessId" = 930002) <> 'TRIALING' THEN RAISE EXCEPTION 'L10: a running trial was expired'; END IF;
END $$;

-- 11. Cascade: removing a business removes its counters, units, adjustments and requests; its trial claims stay
--     (business set to NULL) so the identity cannot reopen a trial.
DELETE FROM "Business" WHERE "id" = 930004;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessUsageCounter" WHERE "businessId" = 930004) OR EXISTS (SELECT 1 FROM "PlatformSubscription" WHERE "businessId" = 930004) THEN
    RAISE EXCEPTION 'L11: cascade left rows';
  END IF;
  IF (SELECT count(*) FROM "PlatformTrialClaim" WHERE "businessId" IS NULL AND "digest" = repeat('a', 64) AND "keyVersion" = 1) < 1 THEN
    RAISE EXCEPTION 'L11: the claim did not outlive the business';
  END IF;
END $$;

-- Clean the lab rows so the evidence (run next) sees the released state again (the matrix restored by the owner).
DELETE FROM "Business" WHERE "id" IN (930002, 930003, 930005, 930006, 930007);
DELETE FROM "PlatformTrialClaim";
DELETE FROM "BusinessUsageEvent";
DELETE FROM "BusinessUsageCounter";
UPDATE "PlatformQuotaPolicy" SET "quota" = 300, "version" = 1, "updatedByUserId" = NULL WHERE "metric" = 'ocr_pages' AND "tier" = 'BASIC';
UPDATE "PlatformUsageMetricMode" SET "mode" = 'SHADOW', "updatedByUserId" = NULL WHERE "metric" = 'video_renders';
-- (the append-only trigger refuses UPDATE only; removing the lab's history row is a DELETE, as the owner)
DELETE FROM "PlatformQuotaPolicyEvent" WHERE "actorUserId" IS NOT NULL;
SELECT 'MIGRATION_LAB_OK' AS result;
