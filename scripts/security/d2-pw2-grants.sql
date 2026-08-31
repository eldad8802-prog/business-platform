-- D2 / PRIVILEGED-WRITE-2 — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- Applied by an owner-privileged operator/workflow AFTER the canonical
-- migration created the RLS policies and the env-neutral `app_ctlplane` NOLOGIN
-- group. Role names are environment-specific and therefore deliberately NOT
-- part of the prisma migration. Replace the placeholders textually (the CI
-- battery does exactly this):
--
--   :ROLE            the tenant runtime role      (Preview: app_runtime_preview_p4b)
--   :CTL_LOGIN_ROLE  the control-plane LOGIN role (Preview: app_ctlplane_preview)
--
-- The control-plane LOGIN role itself is created by the provisioning workflow
-- (create-once, INHERIT, LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB,
-- NOCREATEROLE, non-owner, rotate-password-only — never drop/recreate: the Neon
-- pooler caches role OIDs).
--
-- Every verb below is code-observed from the PW-2 access graph — no GRANT ALL,
-- nothing speculative:
--
--   tenant runtime : SELECT only. `/api/business/capabilities` resolves the
--                    session business's own entitlements inside a tenant
--                    transaction. It never writes; the table is control-plane
--                    configuration, not tenant self-service data.
--   app_admin      : SELECT only, and currently WITHOUT a consumer. The
--                    platform-admin features screen reads one named business
--                    through the explicit-target tenant substrate, so it needs
--                    no cross-tenant credential. p7adm_read is retained so that
--                    any future admin-client read of this table reads correctly
--                    instead of silently returning zero rows. The read-only
--                    admin doctrine is UNCHANGED — no INSERT/UPDATE/DELETE is
--                    added to app_admin anywhere in this wave.
--   app_ctlplane   : SELECT + INSERT + UPDATE on BusinessFeatureAccess only,
--                    plus the append-only PlatformAuditEvent write so mutation
--                    and audit share one transaction, plus two SELECTs the same
--                    transaction needs to validate its target and compute the
--                    resulting effective state.
--
-- ZERO DELETE anywhere: clearing an override is `state = INHERIT`, so the
-- privilege is not needed by any role and is not granted to any role.
--
-- Preserved denials (never granted here): _prisma_migrations, any DDL / CREATE
-- on schema public, table ownership, role management, BYPASSRLS, GRANT OPTION,
-- and any privilege on any other tenant table for the control-plane role.

-- ============================================================
-- Tenant runtime — read own entitlements (GUC-scoped by p7pw2_tenant_read)
-- ============================================================
GRANT SELECT ON "BusinessFeatureAccess" TO :ROLE;
GRANT SELECT ON "PlatformFeaturePolicy" TO :ROLE;

-- ============================================================
-- Platform admin (env-neutral NOLOGIN group) — cross-tenant READ only
-- ============================================================
GRANT SELECT ON "BusinessFeatureAccess" TO app_admin;

-- ============================================================
-- Control plane (env-neutral NOLOGIN group) — the narrow capability
-- ============================================================
-- Schema visibility (Neon does not give SQL-created roles USAGE via PUBLIC).
-- USAGE only — CREATE stays denied.
GRANT USAGE ON SCHEMA public TO app_ctlplane;

GRANT SELECT, INSERT, UPDATE ON "BusinessFeatureAccess" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "BusinessFeatureAccess_id_seq" TO app_ctlplane;

-- Append-only audit, in the SAME transaction as the mutation.
-- INSERT ONLY, deliberately: the audit append uses createMany, which emits a
-- plain INSERT with no RETURNING, so the role needs no SELECT on the audit
-- trail. It can append and can never read, amend or erase what it appended.
GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_ctlplane;

-- Reads the privileged transaction needs: target existence + global policy.
GRANT SELECT ON "Business" TO app_ctlplane;
GRANT SELECT ON "PlatformFeaturePolicy" TO app_ctlplane;

-- ============================================================
-- Environment login role joins the control-plane group (INHERIT membership).
-- ============================================================
GRANT app_ctlplane TO :CTL_LOGIN_ROLE;
