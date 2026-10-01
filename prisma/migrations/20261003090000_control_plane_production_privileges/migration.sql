-- Control plane — environment-neutral privileges for the platform-admin feature-access write path.
--
-- WHY A MIGRATION. 20260901090000_d2_pw2_business_feature_access_rls created the NOLOGIN group
-- `app_ctlplane` and the RLS policies, and left the grants to a per-environment artifact
-- (scripts/security/d2-pw2-grants.sql) because it also names environment-specific LOGIN roles. The two
-- groups this file touches — `app_ctlplane` and the tenant runtime group `app_runtime` — are
-- environment-neutral, so their privileges belong here: reviewed, idempotent, exercised by every lab
-- battery that builds from migrations, and applied to Production only through release-migrate. The one
-- environment-specific piece, the LOGIN role that joins `app_ctlplane`, is provisioned separately
-- (scripts/ops/control-plane-login.ts) and never appears in a migration.
--
-- WHAT PRODUCTION HAD (read-only preflight, run 36791336257):
--   * app_ctlplane: exists, NOLOGIN, NOBYPASSRLS, schema USAGE, and NO table privileges at all.
--   * app_admin: exists, NOLOGIN, no LOGIN member, and NO privileges on these tables. The Preview
--     artifact's `REVOKE SELECT ON "BusinessFeatureAccess" FROM app_admin` is therefore a no-op here and
--     is deliberately not repeated; the evidence asserts the zero instead.
--   * app_runtime (hence app_runtime_prod): SELECT/INSERT/UPDATE/DELETE on BusinessFeatureAccess,
--     PlatformFeaturePolicy, PlatformFeatureDefinition and PlatformAuditEvent — inherited from the
--     owner's DEFAULT PRIVILEGES, not from any reviewed grant. PlatformFeaturePolicy and
--     PlatformFeatureDefinition have NO RLS, so the tenant runtime could flip `globalEnabled` or
--     `emergencyDisabled` for any feature (knowledge_derivation included) and bypass the audited control
--     plane entirely. No code path writes either table at runtime (only migrations, as owner).
--
-- WHAT THIS FILE DOES
--   1. app_ctlplane gets exactly what updateBusinessFeatureAccess executes, nothing else:
--        BusinessFeatureAccess   SELECT, INSERT, and UPDATE of the four columns the service sets
--                                (state, reason, updatedByUserId, updatedAt) — businessId and featureKey
--                                can never be rewritten; RLS already pins every row to the transaction GUC
--        PlatformAuditEvent      INSERT only (append; createMany emits no RETURNING) — never SELECT
--        Business                SELECT (id, name) only — the target check; no other column
--        PlatformFeaturePolicy   SELECT — the effective state after the write
--        the two id sequences    USAGE
--      No DELETE anywhere (clearing an override is state = INHERIT). No DDL, no ownership, no BYPASSRLS.
--   2. app_runtime loses every write it never used on the feature/audit tables:
--        BusinessFeatureAccess, PlatformFeaturePolicy, PlatformFeatureDefinition   keep SELECT only
--        PlatformAuditEvent      keeps SELECT, INSERT (the runtime appends and reads its own admin audit);
--                                loses UPDATE, DELETE — the audit becomes append-only for the runtime
--        BusinessFeatureAccess_id_seq   loses USAGE/UPDATE (the runtime never inserts there)
--   Account erasure is unaffected: the audit's actorUserId ON DELETE SET NULL runs as the table owner.
--
-- Idempotent (GRANT/REVOKE are), and a lab without the runtime group skips step 2.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN
    CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

-- 1. The control plane: the narrow write capability.
GRANT USAGE ON SCHEMA public TO app_ctlplane;
GRANT SELECT, INSERT ON "BusinessFeatureAccess" TO app_ctlplane;
GRANT UPDATE ("state", "reason", "updatedByUserId", "updatedAt") ON "BusinessFeatureAccess" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "BusinessFeatureAccess_id_seq" TO app_ctlplane;
GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_ctlplane;
GRANT SELECT ("id", "name") ON "Business" TO app_ctlplane;
GRANT SELECT ON "PlatformFeaturePolicy" TO app_ctlplane;

-- 2. The tenant runtime: read-only on configuration, append-only on the admin audit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "BusinessFeatureAccess" FROM app_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "PlatformFeaturePolicy" FROM app_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "PlatformFeatureDefinition" FROM app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PlatformAuditEvent" FROM app_runtime;
    REVOKE USAGE, UPDATE ON SEQUENCE "BusinessFeatureAccess_id_seq" FROM app_runtime;
  END IF;
END
$$;
