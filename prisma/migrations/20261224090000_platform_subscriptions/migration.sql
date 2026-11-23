-- ============================================================================================================
-- 20261224090000_platform_subscriptions — DRAFT. NOT APPLIED anywhere. Owner approval required to apply.
--
-- Dubiz subscriptions stage B (plan document stage 3, owner-approved plan 2026-11-24): the subscription record.
-- Plan CONTENT stays in code (lib/services/subscriptions/plan-catalog.ts); the database keeps only which plan and
-- state each business is in, and an append-only log of every change.
--
--   1. table "PlatformSubscription" — at most ONE row per business (the business id is the key):
--        accountType   CUSTOMER | TESTER | INTERNAL
--        status        EXEMPT (TESTER / INTERNAL only) | TRIALING | ACTIVE | PAST_DUE | FREE_LIMITED (CUSTOMER only)
--        plan          BASIC | ADVANCED | PREMIUM, or none; ACTIVE and PAST_DUE require one
--        catalogVersion, trial and period dates, cancelAtPeriodEnd, source, updatedByUserId
--   2. table "PlatformSubscriptionEvent" — append-only: one row per change (from / to, actor, reason, provider id).
--   3. Backfill: EVERY existing business gets a TESTER row (status EXEMPT, no plan, no trial date) and one BACKFILL
--      event — owner decision 5 (2026-11-20): all existing accounts are testers. The platform system business
--      (__PLATFORM_SYSTEM__) is INTERNAL. Nobody starts a trial; nobody is limited.
--   4. FORCE RLS on both tables, by business:
--        app_runtime   SELECT own business's subscription row only (a business can never change its own plan);
--                      nothing on the event log.
--        app_ctlplane  the admin write path (control-plane transaction, GUC-scoped): subscription SELECT / INSERT /
--                      UPDATE of the lifecycle columns; event log INSERT only — like PlatformAuditEvent, the writer
--                      may not read back what it wrote. No DELETE for anyone, no UPDATE on the log (a trigger
--                      refuses it as well).
--
-- Nothing reads these tables until the code PR (stage B code) is merged after this migration is applied; even then
-- the plan verdict is shadow only. Unchanged: every existing table, row, constraint, policy, grant and function.
-- No feature flag, no billing object, no payment object is read or written. Additive only: dropping the two tables
-- and the one function restores the previous state exactly (.platform-subscriptions/rollback.sql).
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."Business"') IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_SUBSCRIPTIONS: Business is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    RAISE EXCEPTION 'PLATFORM_SUBSCRIPTIONS: role app_runtime or app_ctlplane is missing; nothing was changed';
  END IF;
  IF to_regclass('public."PlatformSubscription"') IS NOT NULL OR to_regclass('public."PlatformSubscriptionEvent"') IS NOT NULL THEN
    RAISE EXCEPTION 'PLATFORM_SUBSCRIPTIONS: a subscription table already exists; nothing was changed';
  END IF;
END
$do$;

-- ── 1. The subscription record ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformSubscription" (
  "businessId"         INTEGER      NOT NULL,
  "accountType"        TEXT         NOT NULL,
  "status"             TEXT         NOT NULL,
  "plan"               TEXT,
  "catalogVersion"     TEXT         NOT NULL,
  "trialStartedAt"     TIMESTAMP(3),
  "trialEndsAt"        TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd"   TIMESTAMP(3),
  "cancelAtPeriodEnd"  BOOLEAN      NOT NULL DEFAULT false,
  "source"             TEXT         NOT NULL,
  "updatedByUserId"    INTEGER,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSubscription_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "PlatformSubscription_account_type" CHECK ("accountType" IN ('CUSTOMER', 'TESTER', 'INTERNAL')),
  CONSTRAINT "PlatformSubscription_status" CHECK ("status" IN ('EXEMPT', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'FREE_LIMITED')),
  CONSTRAINT "PlatformSubscription_plan" CHECK ("plan" IS NULL OR "plan" IN ('BASIC', 'ADVANCED', 'PREMIUM')),
  CONSTRAINT "PlatformSubscription_source" CHECK ("source" IN ('BACKFILL', 'ADMIN', 'SIGNUP', 'CHECKOUT', 'PROVIDER')),
  CONSTRAINT "PlatformSubscription_catalog_version" CHECK ("catalogVersion" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  -- Testers and internal accounts have no lifecycle; a customer always has one.
  CONSTRAINT "PlatformSubscription_exempt_iff_not_customer" CHECK (("accountType" = 'CUSTOMER') = ("status" <> 'EXEMPT')),
  CONSTRAINT "PlatformSubscription_paid_needs_plan" CHECK ("status" NOT IN ('ACTIVE', 'PAST_DUE') OR "plan" IS NOT NULL),
  CONSTRAINT "PlatformSubscription_trial_needs_end" CHECK ("status" <> 'TRIALING' OR "trialEndsAt" IS NOT NULL),
  CONSTRAINT "PlatformSubscription_trial_order" CHECK ("trialStartedAt" IS NULL OR "trialEndsAt" IS NULL OR "trialEndsAt" > "trialStartedAt"),
  CONSTRAINT "PlatformSubscription_period_order" CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" IS NULL OR "currentPeriodEnd" > "currentPeriodStart")
);

ALTER TABLE "PlatformSubscription" ADD CONSTRAINT "PlatformSubscription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. The append-only log ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformSubscriptionEvent" (
  "id"              BIGSERIAL    NOT NULL,
  "businessId"      INTEGER      NOT NULL,
  "kind"            TEXT         NOT NULL,
  "fromAccountType" TEXT,
  "toAccountType"   TEXT         NOT NULL,
  "fromStatus"      TEXT,
  "toStatus"        TEXT         NOT NULL,
  "fromPlan"        TEXT,
  "toPlan"          TEXT,
  "actorUserId"     INTEGER,
  "reason"          TEXT         NOT NULL,
  "providerEventId" TEXT,
  "catalogVersion"  TEXT         NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSubscriptionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformSubscriptionEvent_kind" CHECK ("kind" IN ('BACKFILL', 'ADMIN_CHANGE', 'SYSTEM_TRANSITION', 'PROVIDER_EVENT')),
  CONSTRAINT "PlatformSubscriptionEvent_reason" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "PlatformSubscriptionEvent_admin_has_actor" CHECK ("kind" <> 'ADMIN_CHANGE' OR "actorUserId" IS NOT NULL),
  CONSTRAINT "PlatformSubscriptionEvent_provider_has_id" CHECK ("kind" <> 'PROVIDER_EVENT' OR "providerEventId" IS NOT NULL),
  CONSTRAINT "PlatformSubscriptionEvent_values" CHECK (
        "toAccountType" IN ('CUSTOMER', 'TESTER', 'INTERNAL')
    AND ("fromAccountType" IS NULL OR "fromAccountType" IN ('CUSTOMER', 'TESTER', 'INTERNAL'))
    AND "toStatus" IN ('EXEMPT', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'FREE_LIMITED')
    AND ("fromStatus" IS NULL OR "fromStatus" IN ('EXEMPT', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'FREE_LIMITED'))
    AND ("toPlan" IS NULL OR "toPlan" IN ('BASIC', 'ADVANCED', 'PREMIUM'))
    AND ("fromPlan" IS NULL OR "fromPlan" IN ('BASIC', 'ADVANCED', 'PREMIUM')))
);

CREATE UNIQUE INDEX "PlatformSubscriptionEvent_providerEventId_key" ON "PlatformSubscriptionEvent"("providerEventId");
CREATE INDEX "PlatformSubscriptionEvent_businessId_createdAt_idx" ON "PlatformSubscriptionEvent"("businessId", "createdAt");

ALTER TABLE "PlatformSubscriptionEvent" ADD CONSTRAINT "PlatformSubscriptionEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The log is never rewritten: refuse UPDATE for every role, the owner included.
CREATE OR REPLACE FUNCTION public.platform_subscription_event_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'PLATFORM_SUBSCRIPTION_EVENT_APPEND_ONLY: the subscription log is never changed';
END
$fn$;
REVOKE ALL ON FUNCTION public.platform_subscription_event_append_only() FROM PUBLIC;

CREATE TRIGGER "PlatformSubscriptionEvent_append_only" BEFORE UPDATE ON "PlatformSubscriptionEvent"
  FOR EACH ROW EXECUTE FUNCTION public.platform_subscription_event_append_only();

-- ── 3. Backfill — every existing business is a tester (before RLS, as the migration owner) ───────────────────

INSERT INTO "PlatformSubscription" ("businessId", "accountType", "status", "plan", "catalogVersion", "source", "updatedAt")
SELECT b."id",
       CASE WHEN b."name" = '__PLATFORM_SYSTEM__' THEN 'INTERNAL' ELSE 'TESTER' END,
       'EXEMPT', NULL, '2026-11-20', 'BACKFILL', CURRENT_TIMESTAMP
  FROM "Business" b;

INSERT INTO "PlatformSubscriptionEvent" ("businessId", "kind", "toAccountType", "toStatus", "toPlan", "reason", "catalogVersion")
SELECT s."businessId", 'BACKFILL', s."accountType", s."status", NULL,
       'existing account at activation — tester by owner decision 2026-11-20', s."catalogVersion"
  FROM "PlatformSubscription" s;

DO $do$
DECLARE nb bigint; ns bigint; ne bigint; nt bigint;
BEGIN
  SELECT count(*) INTO nb FROM "Business";
  SELECT count(*) INTO ns FROM "PlatformSubscription";
  SELECT count(*) INTO ne FROM "PlatformSubscriptionEvent";
  SELECT count(*) INTO nt FROM "PlatformSubscription" WHERE "accountType" IN ('TESTER', 'INTERNAL') AND "status" = 'EXEMPT'
     AND "plan" IS NULL AND "trialStartedAt" IS NULL AND "trialEndsAt" IS NULL;
  IF ns <> nb OR ne <> nb OR nt <> nb THEN
    RAISE EXCEPTION 'PLATFORM_SUBSCRIPTIONS: backfill mismatch (businesses %, rows %, events %, exempt %); nothing was changed', nb, ns, ne, nt;
  END IF;
END
$do$;

-- ── 4. FORCE RLS and exact grants ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PlatformSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_subscription_tenant_select ON "PlatformSubscription" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY platform_subscription_ctl_insert ON "PlatformSubscription" FOR INSERT TO app_ctlplane
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY platform_subscription_ctl_update ON "PlatformSubscription" FOR UPDATE TO app_ctlplane
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PlatformSubscriptionEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformSubscriptionEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_subscription_event_ctl_insert ON "PlatformSubscriptionEvent" FOR INSERT TO app_ctlplane
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Grants: exactly what the application needs, nothing inherited from default privileges.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
           pg_get_userbyid(x.grantee) AS grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('PlatformSubscription', 'PlatformSubscriptionEvent', 'PlatformSubscriptionEvent_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %I', r.kind, r.rel, r.grantee);
  END LOOP;
END
$do$;
GRANT SELECT ON "PlatformSubscription" TO app_runtime;
GRANT SELECT, INSERT ON "PlatformSubscription" TO app_ctlplane;
GRANT UPDATE ("accountType", "status", "plan", "catalogVersion", "trialStartedAt", "trialEndsAt", "currentPeriodStart",
              "currentPeriodEnd", "cancelAtPeriodEnd", "source", "updatedByUserId", "updatedAt")
  ON "PlatformSubscription" TO app_ctlplane;
GRANT INSERT ON "PlatformSubscriptionEvent" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "PlatformSubscriptionEvent_id_seq" TO app_ctlplane;
