-- D2 / PRIVILEGED-WRITE-2 — full rollback (policies + grants). Restores the
-- pre-PW-2 posture for BusinessFeatureAccess and nothing else.
--
--   :ROLE            the tenant runtime role      (Preview: app_runtime_preview_p4b)
--   :CTL_LOGIN_ROLE  the control-plane LOGIN role (Preview: app_ctlplane_preview)
--
-- NON-DESTRUCTIVE BY CONSTRUCTION:
--   * Never drops a role. `app_ctlplane` and the environment LOGIN role are
--     persistent (the Neon pooler caches role OIDs — create once, rotate the
--     password, never drop/recreate). After this script they simply hold no
--     privilege on this table.
--   * Never touches BusinessFeatureAccess or PlatformAuditEvent DATA.
--   * Never touches any prior wave: p4b_tenant, p7w1..p7w4eb2 tenant policies,
--     the p7adm_read family on other tables, and every existing app_admin grant
--     (including the pre-existing append-only PlatformAuditEvent INSERT) are
--     left exactly as they were.
--   * Never re-widens anything: it revokes, it does not grant.
--
-- IMPORTANT: this rolls back the DB ENFORCEMENT only. It does NOT and must not
-- revert the application-layer repairs shipped with PW-2 — the tenant-context
-- resolver, the admin read moving to the admin client, and the removal of the
-- context-less transaction are correctness fixes that stand on their own and are
-- strictly safer than what preceded them. Reverting policies is never a reason
-- to restore a fail-open read or a false-success audit.

-- ============================================================
-- 1. Policies
-- ============================================================
DROP POLICY IF EXISTS p7pw2_ctl_update ON "BusinessFeatureAccess";
DROP POLICY IF EXISTS p7pw2_ctl_insert ON "BusinessFeatureAccess";
DROP POLICY IF EXISTS p7adm_read       ON "BusinessFeatureAccess";
DROP POLICY IF EXISTS p7pw2_tenant_read ON "BusinessFeatureAccess";

ALTER TABLE "BusinessFeatureAccess" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BusinessFeatureAccess" DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. Grants added by PW-2 only
-- ============================================================
REVOKE ALL PRIVILEGES ON "BusinessFeatureAccess" FROM app_ctlplane;
REVOKE ALL PRIVILEGES ON SEQUENCE "BusinessFeatureAccess_id_seq" FROM app_ctlplane;
REVOKE ALL PRIVILEGES ON "PlatformAuditEvent" FROM app_ctlplane;
REVOKE ALL PRIVILEGES ON SEQUENCE "PlatformAuditEvent_id_seq" FROM app_ctlplane;
REVOKE ALL PRIVILEGES ON "Business" FROM app_ctlplane;
REVOKE ALL PRIVILEGES ON "PlatformFeaturePolicy" FROM app_ctlplane;
REVOKE USAGE ON SCHEMA public FROM app_ctlplane;

REVOKE ALL PRIVILEGES ON "BusinessFeatureAccess" FROM app_admin;

REVOKE ALL PRIVILEGES ON "BusinessFeatureAccess" FROM :ROLE;
-- NOTE: PlatformFeaturePolicy SELECT is NOT revoked from :ROLE here — it is a
-- global config read that other paths may legitimately share. Revoking a grant
-- this artifact may not have created would be a silent widening of the rollback
-- blast radius, which is exactly what "remove only PW-2 additions" forbids.

-- Group membership is left in place: the login role stays a powerless member of
-- a now-privilege-less group, which is the reversible state.
