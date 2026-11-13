-- ============================================================================================================
-- Notification engine activation (notifications track, PR 2c — migration only; owner decisions 2026-11-13).
--
-- DEPENDS ON 20261211090000_notification_engine_followup (PR 2b), which depends on
-- 20261210090000_notification_engine_foundation (PR #1143): the feature row `notifications_engine` (definition +
-- policy, OFF) is 2b's; the owed pushes this table gates are the foundation's. Its timestamp sorts after both, so
-- `prisma migrate deploy` applies the three in order; it must never be applied without them.
--
-- WHY. The worker's clean start ("no push for an event created before the engine was enabled for the business")
-- used to derive the moment from max(override.updatedAt, policy.updatedAt). The policy row is GLOBAL: any admin edit
-- of it moved the moment for EVERY business and closed the pushes waiting for the end of quiet hours. The moment now
-- lives in its own per-business row, written only when the engine's EFFECTIVE state for that business changes.
--
-- THE RULE (lib/notifications/engine/worker-decision.ts implements the same predicate, pushableCreatedAt()):
--   * firstActivatedAt  the first moment the engine was effectively ON for the business. Never moves again.
--                       Nothing created before it is ever pushed.
--   * lastActivatedAt   the start of the CURRENT (or last) ON period.
--   * lastDeactivatedAt the end of the last ON period (NULL = never turned OFF since the first activation).
--   * priorActivatedAt  the start of the ON period that lastDeactivatedAt ended (= firstActivatedAt until a re-
--                       activation).
--   While ON, an owed push may be sent only if it was created in the CURRENT ON period ([lastActivatedAt, ∞)) or in
--   the ON period just before it ([priorActivatedAt, lastDeactivatedAt)) — and, as always, before its TTL. So:
--     - nothing created while the engine was OFF is ever pushed (no wave after OFF → ON);
--     - a push deferred by quiet hours in the last ON period survives one OFF → ON (kill switch lifted, override
--       re-enabled) and goes out at the end of the quiet hours if still inside its TTL;
--     - older ON periods are dropped (two toggles back is history, never a wave);
--     - a policy edit that does not change the business's effective state changes nothing at all.
--
-- WHO WRITES IT. Nobody but these SECURITY DEFINER functions (the runtime holds SELECT only):
--   1. a trigger on "BusinessFeatureAccess" (featureKey 'notifications_engine'): the platform admin's per-business
--      switch — written by app_ctlplane, which holds nothing on this table. The moment is the row's own "updatedAt"
--      when the statement stamped it (the admin mutation stamps every state change), else the statement time.
--   2. a trigger on "PlatformFeaturePolicy" (featureKey 'notifications_engine'), only when globalEnabled or
--      emergencyDisabled actually change: records the transitions that change produced for each business it
--      decides (the kill switch).
--   3. notification_engine_observe(business, on, at) — the push worker, in the business's own tenant transaction:
--      records the first moment it sees the engine ON for a business enabled only through the global policy (and
--      ON → OFF it sees the same way). It refuses a claim that contradicts what SQL can decide by itself.
--   The effective state SQL can decide (notification_engine_effective) mirrors resolveFeatureAccessFromInputs():
--   emergency → OFF; override DISABLED → OFF; override ENABLED → ON; globalEnabled false → OFF; otherwise it
--   depends on the catalog default (code) → UNKNOWN, left to the worker's observation. A trigger never guesses.
--
-- Expand-only. One new table, five new functions, two new triggers, a backfill of the new table only. Nothing
-- dropped, renamed or narrowed; no existing row changes; every statement the current application issues keeps
-- working (the triggers add a row to the new table and never fail on the old paths' values). The application that
-- reads the table comes in the engine's code PR (migration-first).
--
-- Erasure: the row holds a business id, four times and a closed source token — nothing about a person. It goes
-- with the business (ON DELETE CASCADE). No DELETE policy, no DELETE grant.
-- ============================================================================================================

-- ── 1. The table ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "NotificationEngineActivation" (
  "businessId" INTEGER NOT NULL,
  "firstActivatedAt" TIMESTAMP(3) NOT NULL,
  "lastActivatedAt" TIMESTAMP(3) NOT NULL,
  "priorActivatedAt" TIMESTAMP(3) NOT NULL,
  "lastDeactivatedAt" TIMESTAMP(3),
  "lastSource" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationEngineActivation_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "NotificationEngineActivation_order" CHECK (
        "firstActivatedAt" <= "priorActivatedAt"
    AND "priorActivatedAt" <= "lastActivatedAt"
    AND ("lastDeactivatedAt" IS NULL OR "lastDeactivatedAt" >= "priorActivatedAt")
    AND ("lastDeactivatedAt" IS NOT NULL OR ("priorActivatedAt" = "firstActivatedAt" AND "lastActivatedAt" = "firstActivatedAt"))),
  CONSTRAINT "NotificationEngineActivation_source" CHECK ("lastSource" IN ('override', 'policy', 'worker', 'migration'))
);
ALTER TABLE "NotificationEngineActivation" ADD CONSTRAINT "NotificationEngineActivation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationEngineActivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationEngineActivation" FORCE ROW LEVEL SECURITY;
-- Read: the business's own row (the worker and the dry run, in its tenant transaction). No INSERT / UPDATE /
-- DELETE policy: writes happen only inside the definer functions below (the migration role, BYPASSRLS).
CREATE POLICY notification_engine_activation_tenant_select ON "NotificationEngineActivation" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

REVOKE ALL ON "NotificationEngineActivation" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "NotificationEngineActivation" FROM app_runtime;
    GRANT SELECT ON "NotificationEngineActivation" TO app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    REVOKE ALL ON "NotificationEngineActivation" FROM app_ctlplane;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    REVOKE ALL ON "NotificationEngineActivation" FROM app_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    REVOKE ALL ON "NotificationEngineActivation" FROM app_admin;
  END IF;
END
$do$;

-- ── 2. The effective state SQL can decide (NULL = the catalog default decides: unknown here) ─────────────────

CREATE OR REPLACE FUNCTION public.notification_engine_effective(p_state text, p_global boolean, p_emergency boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT CASE
    WHEN coalesce(p_emergency, false) THEN false
    WHEN p_state = 'DISABLED' THEN false
    WHEN p_state = 'ENABLED' THEN true
    WHEN p_global IS NOT NULL AND NOT p_global THEN false
    ELSE NULL
  END
$fn$;
REVOKE ALL ON FUNCTION public.notification_engine_effective(text, boolean, boolean) FROM PUBLIC;

-- ── 3. One transition, idempotent (callers: the definer functions only) ──────────────────────────────────────
-- Returns 'activated' (first ever), 'reactivated' (OFF → ON), 'deactivated' (ON → OFF) or 'unchanged'.
-- Moments only move forward: a re-activation lands strictly after the recorded deactivation, a deactivation at or
-- after the recorded activation, so the recorded state is always lastDeactivatedAt >= lastActivatedAt ⇔ OFF.

CREATE OR REPLACE FUNCTION public.notification_engine_record(p_business integer, p_on boolean, p_at timestamp(3), p_source text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  r "NotificationEngineActivation"%ROWTYPE;
  v_now timestamp(3) := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  v_at timestamp(3);
BEGIN
  IF p_business IS NULL OR p_on IS NULL OR p_at IS NULL THEN
    RETURN 'unchanged';
  END IF;
  SELECT * INTO r FROM "NotificationEngineActivation" WHERE "businessId" = p_business FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT p_on THEN
      RETURN 'unchanged';
    END IF;
    INSERT INTO "NotificationEngineActivation"
      ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastDeactivatedAt", "lastSource", "updatedAt")
    VALUES (p_business, p_at, p_at, p_at, NULL, p_source, v_now)
    ON CONFLICT ("businessId") DO NOTHING;
    IF FOUND THEN
      RETURN 'activated';
    END IF;
    -- A concurrent first activation won: decide against its row.
    SELECT * INTO r FROM "NotificationEngineActivation" WHERE "businessId" = p_business FOR UPDATE;
  END IF;

  IF r."lastDeactivatedAt" IS NOT NULL AND r."lastDeactivatedAt" >= r."lastActivatedAt" THEN
    -- recorded OFF
    IF NOT p_on THEN
      RETURN 'unchanged';
    END IF;
    v_at := GREATEST(p_at, r."lastDeactivatedAt" + interval '1 millisecond');
    UPDATE "NotificationEngineActivation"
       SET "priorActivatedAt" = r."lastActivatedAt", "lastActivatedAt" = v_at, "lastSource" = p_source, "updatedAt" = v_now
     WHERE "businessId" = p_business;
    RETURN 'reactivated';
  END IF;

  -- recorded ON
  IF p_on THEN
    RETURN 'unchanged';
  END IF;
  v_at := GREATEST(p_at, r."lastActivatedAt");
  UPDATE "NotificationEngineActivation"
     SET "lastDeactivatedAt" = v_at, "lastSource" = p_source, "updatedAt" = v_now
   WHERE "businessId" = p_business;
  RETURN 'deactivated';
END
$fn$;
REVOKE ALL ON FUNCTION public.notification_engine_record(integer, boolean, timestamp(3), text) FROM PUBLIC;

-- ── 4. The per-business switch (the platform admin's override) ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notification_engine_override_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_on boolean;
  v_at timestamp(3) := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  SELECT public.notification_engine_effective(NEW."state"::text, p."globalEnabled", p."emergencyDisabled")
    INTO v_on
    FROM (SELECT 1) AS one
    LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = 'notifications_engine';
  IF v_on IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_at := coalesce(NEW."updatedAt", v_at);
  ELSIF NEW."updatedAt" IS DISTINCT FROM OLD."updatedAt" AND NEW."updatedAt" IS NOT NULL THEN
    v_at := NEW."updatedAt";
  END IF;
  PERFORM public.notification_engine_record(NEW."businessId", v_on, v_at, 'override');
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.notification_engine_override_changed() FROM PUBLIC;

CREATE TRIGGER "BusinessFeatureAccess_notification_engine_activation"
  AFTER INSERT OR UPDATE OF "state" ON "BusinessFeatureAccess"
  FOR EACH ROW
  WHEN (NEW."featureKey" = 'notifications_engine')
  EXECUTE FUNCTION public.notification_engine_override_changed();

-- ── 5. The global policy (kill switch): only a real change of globalEnabled / emergencyDisabled ──────────────

CREATE OR REPLACE FUNCTION public.notification_engine_policy_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  b record;
  v_on boolean;
  v_at timestamp(3) := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."globalEnabled" IS NOT DISTINCT FROM OLD."globalEnabled"
       AND NEW."emergencyDisabled" IS NOT DISTINCT FROM OLD."emergencyDisabled" THEN
      RETURN NULL;   -- an edit that changes nobody's effective state moves nobody's moment
    END IF;
    IF NEW."updatedAt" IS DISTINCT FROM OLD."updatedAt" AND NEW."updatedAt" IS NOT NULL THEN
      v_at := NEW."updatedAt";
    END IF;
  ELSE
    v_at := coalesce(NEW."updatedAt", v_at);
  END IF;
  FOR b IN
    SELECT a."businessId", a."state"::text AS "state"
      FROM "BusinessFeatureAccess" a
     WHERE a."featureKey" = 'notifications_engine'
    UNION ALL
    SELECT e."businessId", NULL::text
      FROM "NotificationEngineActivation" e
     WHERE NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" a
                        WHERE a."businessId" = e."businessId" AND a."featureKey" = 'notifications_engine')
     ORDER BY 1
  LOOP
    v_on := public.notification_engine_effective(b."state", NEW."globalEnabled", NEW."emergencyDisabled");
    IF v_on IS NOT NULL THEN
      PERFORM public.notification_engine_record(b."businessId", v_on, v_at, 'policy');
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.notification_engine_policy_changed() FROM PUBLIC;

CREATE TRIGGER "PlatformFeaturePolicy_notification_engine_activation"
  AFTER INSERT OR UPDATE ON "PlatformFeaturePolicy"
  FOR EACH ROW
  WHEN (NEW."featureKey" = 'notifications_engine')
  EXECUTE FUNCTION public.notification_engine_policy_changed();

-- ── 6. The worker's observation (its own business only; identifiers and times only) ──────────────────────────

CREATE OR REPLACE FUNCTION public.notification_engine_observe(p_business integer, p_on boolean, p_at timestamp(3))
RETURNS TABLE ("outcome" text, "first_at" timestamp(3), "last_at" timestamp(3), "prior_at" timestamp(3), "deactivated_at" timestamp(3))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_sql boolean;
  v_out text;
BEGIN
  IF p_business IS NULL OR p_business IS DISTINCT FROM NULLIF(current_setting('app.current_business_id', true), '')::int THEN
    RAISE EXCEPTION 'notification_engine_observe: only the business of this tenant context' USING ERRCODE = '42501';
  END IF;
  SELECT public.notification_engine_effective(a."state"::text, p."globalEnabled", p."emergencyDisabled")
    INTO v_sql
    FROM (SELECT 1) AS one
    LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = 'notifications_engine'
    LEFT JOIN "BusinessFeatureAccess" a ON a."businessId" = p_business AND a."featureKey" = 'notifications_engine';
  IF p_on IS NULL OR (v_sql IS NOT NULL AND v_sql IS DISTINCT FROM p_on) THEN
    v_out := 'refused';   -- contradicts what the override / policy decide by themselves (their triggers record it)
  ELSE
    v_out := public.notification_engine_record(p_business, p_on,
               coalesce(p_at, (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)), 'worker');
  END IF;
  RETURN QUERY
    SELECT v_out, e."firstActivatedAt", e."lastActivatedAt", e."priorActivatedAt", e."lastDeactivatedAt"
      FROM (SELECT 1) AS one
      LEFT JOIN "NotificationEngineActivation" e ON e."businessId" = p_business;
END
$fn$;
REVOKE ALL ON FUNCTION public.notification_engine_observe(integer, boolean, timestamp(3)) FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION public.notification_engine_observe(integer, boolean, timestamp(3)) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.notification_engine_observe(integer, boolean, timestamp(3)) TO app_runtime;
  END IF;
END
$do$;

-- ── 7. Backfill: a business already ON when this is released starts NOW (nothing older is pushed) ────────────
-- Production has no notifications_engine override at release time (2b's proof asserts it); a lab or Preview may.

INSERT INTO "NotificationEngineActivation"
  ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastDeactivatedAt", "lastSource", "updatedAt")
SELECT a."businessId", m.t, m.t, m.t, NULL, 'migration', m.t
  FROM "BusinessFeatureAccess" a
  CROSS JOIN (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS t) m
  LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = 'notifications_engine'
 WHERE a."featureKey" = 'notifications_engine'
   AND public.notification_engine_effective(a."state"::text, p."globalEnabled", p."emergencyDisabled") IS TRUE
ON CONFLICT ("businessId") DO NOTHING;
