-- LAB FIXTURE ONLY (not a migration): a verbatim copy of PR #959's migration (branch db/platform-feature-emergency-switch,
-- prisma/migrations/20261114090000_platform_feature_emergency_switch/migration.sql, sha256 82363679151ec8fb5004ff9f347a359f7f69f0a3f1737c1d3c856866adb55975).
-- The activation battery (.nte2c/battery.ts §12) installs it in the lab to prove the two do not interfere.
-- ---------------------------------------------------------------------------------------------------------------
-- Leads L1.5-a · owner decisions 2026-11-05: an audited, locked platform EMERGENCY SWITCH for the seven intake sources.
--
-- WHY A FUNCTION, NOT A COLUMN GRANT
--   PlatformFeaturePolicy has no RLS and drives every feature of the platform. 20261003090000 deliberately left the
--   control plane (app_ctlplane) with SELECT only and took every write from the tenant runtime. A column grant
--   (UPDATE "emergencyDisabled" TO app_ctlplane) would let ANY control-plane code path flip the switch of ANY feature
--   (knowledge derivation included), without the lock and without an audit row. This function is the whole
--   capability instead, and the database itself enforces its limits:
--     * only the seven intake source features (a fixed allowlist) — nothing else can be switched;
--     * only "emergencyDisabled" (+ who / when) — globalEnabled and every other column are untouchable;
--     * an actor (an existing User) and a reason (10–500 characters) are required;
--     * the exclusive advisory lock (namespace 0x4647 'FG', key hashtext(featureKey)) is taken FIRST, in the same
--       transaction as the update: the intake writers hold the SHARED form of that lock while they re-check the gate
--       and write, so once this function returns, no write that read the old state can still commit;
--     * lock_timeout 5 s: the switch fails cleanly (nothing written) rather than waiting without bound;
--     * the audit row (PlatformAuditEvent) is written in the SAME transaction — a change without its audit row cannot
--       commit, and a failed call leaves neither.
--   app_ctlplane receives EXECUTE on this function and nothing else; no table privilege changes. Actor identity, the
--   platform-admin role and MFA stay the route's job (a database role is not proof of a person).
--
-- Additive only. Applying it changes no behaviour: nothing calls the function until the application PR ships the
-- admin tool, and the switch states are not touched.

CREATE FUNCTION public.platform_set_feature_emergency(
  p_feature_key   text,
  p_on            boolean,
  p_actor_user_id integer,
  p_reason        text,
  p_ip            text,
  p_user_agent    text
)
RETURNS TABLE (was_on boolean, is_on boolean, audit_event_id integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_prev   boolean;
  v_audit  integer;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF p_feature_key IS NULL OR p_feature_key NOT IN (
       'acquisition_web_forms', 'acquisition_google_lead_forms', 'acquisition_meta_lead_ads',
       'commerce_woocommerce', 'commerce_wix', 'telephony_cloudtalk', 'telephony_voicenter') THEN
    RAISE EXCEPTION 'emergency switch: not an intake source feature' USING ERRCODE = '22023';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'emergency switch: the target state is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_actor_user_id) THEN
    RAISE EXCEPTION 'emergency switch: an existing actor is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'emergency switch: a reason of 10 to 500 characters is required' USING ERRCODE = '22023';
  END IF;

  -- Exclusive, before anything is read: waits for every intake write that holds the shared form (and is bounded by
  -- lock_timeout), then blocks new ones until this transaction ends.
  PERFORM pg_advisory_xact_lock(17991, hashtext(p_feature_key));

  SELECT p."emergencyDisabled" INTO v_prev
    FROM public."PlatformFeaturePolicy" p
   WHERE p."featureKey" = p_feature_key
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emergency switch: no policy row for this feature' USING ERRCODE = '22023';
  END IF;

  UPDATE public."PlatformFeaturePolicy"
     SET "emergencyDisabled" = p_on, "updatedByUserId" = p_actor_user_id, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "featureKey" = p_feature_key;

  INSERT INTO public."PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata", "ip", "userAgent", "createdAt")
  VALUES (
    p_actor_user_id, 'PLATFORM_FEATURE_EMERGENCY_SET', 'PlatformFeature', p_feature_key,
    jsonb_build_object('previous', v_prev, 'current', p_on, 'changed', v_prev IS DISTINCT FROM p_on, 'reason', v_reason),
    left(p_ip, 64), left(p_user_agent, 256), CURRENT_TIMESTAMP
  )
  RETURNING "id" INTO v_audit;

  RETURN QUERY SELECT v_prev, p_on, v_audit;
END
$fn$;

REVOKE ALL ON FUNCTION public.platform_set_feature_emergency(text, boolean, integer, text, text, text) FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    GRANT EXECUTE ON FUNCTION public.platform_set_feature_emergency(text, boolean, integer, text, text, text) TO app_ctlplane;
  END IF;
END
$do$;
