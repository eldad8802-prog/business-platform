-- D2 / PRIVILEGED-WRITE-2 — control-plane write isolation for BusinessFeatureAccess.
--
-- Same contract as every P7 wave: EXPAND-ONLY, idempotent, environment-portable,
-- role-free except the env-NEUTRAL NOLOGIN GROUP roles. No login role names, no
-- endpoints, no passwords, no per-environment grants live here (those are in
-- scripts/security/d2-pw2-grants.sql). INERT under an owner/BYPASSRLS runtime
-- (production today); enforcing under a least-privilege runtime role.
--
-- Fail-closed tenant predicate (the proven shape, unchanged):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
-- With no GUC set, current_setting(..., true) returns '', NULLIF yields NULL,
-- and the comparison is NULL — so no row qualifies. Fail-closed by construction.
--
-- CLASSIFICATION: BusinessFeatureAccess is CONTROL-PLANE CONFIGURATION TARGETING
-- A BUSINESS, not tenant-owned mutable business data. The tenant may read its own
-- entitlements; it may never write them. Writes belong to an authorized
-- platform-admin action executing through the dedicated control-plane role, and
-- even that role can only ever reach the single business named by the
-- transaction-local GUC.
--
-- WHY NO DELETE ANYWHERE: clearing an override is expressed as the existing
-- `INHERIT` enum state, which the resolver already treats as "no effective
-- override". There is therefore no DELETE policy and no DELETE grant — the
-- privilege simply does not exist for any role.

-- ============================================================
-- 1. Env-neutral control-plane GROUP role (NOLOGIN, no privileges of its own).
--    Each environment attaches its own LOGIN role (Preview:
--    app_ctlplane_preview) in the per-environment security artifact, NEVER here.
--    Roles are cluster-global, so the guarded creation makes re-running a no-op.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

-- ============================================================
-- 2. RLS on BusinessFeatureAccess.
-- ============================================================
ALTER TABLE "BusinessFeatureAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessFeatureAccess" FORCE ROW LEVEL SECURITY;

-- 2a. Read: own business only, for every role that is not covered by a more
--     permissive policy below. This is the tenant's read path AND the
--     control-plane role's in-transaction read (both are GUC-scoped).
DROP POLICY IF EXISTS p7pw2_tenant_read ON "BusinessFeatureAccess";
CREATE POLICY p7pw2_tenant_read ON "BusinessFeatureAccess"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- 2b. Admin cross-tenant read — SELECT ONLY, the unchanged p7adm_read doctrine.
--     Permissive policies OR together, so this adds a read branch for members of
--     app_admin and changes nothing for any other role.
DROP POLICY IF EXISTS p7adm_read ON "BusinessFeatureAccess";
CREATE POLICY p7adm_read ON "BusinessFeatureAccess"
  FOR SELECT TO app_admin
  USING (true);

-- 2c. The capability: control-plane INSERT, locked to the GUC-named business.
DROP POLICY IF EXISTS p7pw2_ctl_insert ON "BusinessFeatureAccess";
CREATE POLICY p7pw2_ctl_insert ON "BusinessFeatureAccess"
  FOR INSERT TO app_ctlplane
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- 2d. The capability: control-plane UPDATE, locked to the GUC-named business on
--     both sides — the row it may touch and the row it may leave behind.
DROP POLICY IF EXISTS p7pw2_ctl_update ON "BusinessFeatureAccess";
CREATE POLICY p7pw2_ctl_update ON "BusinessFeatureAccess"
  FOR UPDATE TO app_ctlplane
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- 2e. DELETE: deliberately NO policy for any role. Under FORCE RLS a table with
--     no DELETE policy denies every DELETE regardless of grants.
