-- D2 / P7-W2-GATE — starter admin grants (PER-ENVIRONMENT artifact).
--
-- Applied by an owner-privileged operator/workflow AFTER the canonical
-- migration created the `app_admin` NOLOGIN group. Grants target the GROUP;
-- the environment's LOGIN role (:LOGIN_ROLE — Preview: app_admin_preview)
-- inherits them through membership. The login role itself is created by the
-- provisioning workflow (create-once, INHERIT, NOBYPASSRLS, non-owner,
-- rotate-password-only — never drop/recreate: Neon pooler OID cache).
--
-- STARTER SET ONLY (architecture-proof slice — not the full 17-table admin
-- matrix): SELECT on Conversation + BillingDocument (RLS'd, via p7adm_read),
-- User + Business (bootstrap-global reads), PlatformFeaturePolicy (global
-- config), PlatformAuditEvent (audit list) — and the ONE approved admin
-- write: INSERT on PlatformAuditEvent (+sequence; SELECT already granted and
-- also required by Prisma's INSERT..RETURNING).
--
-- Denials preserved (never granted): UPDATE/DELETE anywhere, DDL,
-- _prisma_migrations, CREATE on schema, ownership, role management,
-- BYPASSRLS, GRANT ALL.

-- Schema visibility (Neon does not give SQL-created roles USAGE via PUBLIC).
-- USAGE only — CREATE stays denied.
GRANT USAGE ON SCHEMA public TO app_admin;

GRANT SELECT ON "Conversation" TO app_admin;
GRANT SELECT ON "BillingDocument" TO app_admin;
GRANT SELECT ON "User" TO app_admin;
GRANT SELECT ON "Business" TO app_admin;
GRANT SELECT ON "PlatformFeaturePolicy" TO app_admin;
GRANT SELECT, INSERT ON "PlatformAuditEvent" TO app_admin;
GRANT USAGE, SELECT ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_admin;

-- Environment login role joins the group (INHERIT membership).
GRANT app_admin TO :LOGIN_ROLE;
