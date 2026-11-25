-- Subscriptions stage C — CODE lab setup. Run as the owner on a database built by `prisma db push` of the code branch,
-- BEFORE the migrations: drops the push-made copies of the subscription tables (the migrations create the real ones),
-- creates the four application roles and one LOGIN member of each, grants the runtime what Production gives it on the
-- tables the code touches, and creates the tester and the users the lab expects. The businesses WITHOUT a record (930020–930029) are created
-- AFTER the migrations by code-lab-after.sql (the stage B backfill would make them testers).
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS "PlatformUsageMetricMode", "BusinessUsageEvent", "BusinessUsageCounter", "BusinessQuotaAdjustment",
  "PlatformQuotaPolicyEvent", "PlatformQuotaPolicy", "PlatformSubscriptionRequest", "PlatformTrialClaim",
  "PlatformSubscriptionEvent", "PlatformSubscription";
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_rt_login') THEN CREATE ROLE sc_rt_login LOGIN PASSWORD 'sc_rt_pw' IN ROLE app_runtime; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_ctl_login') THEN CREATE ROLE sc_ctl_login LOGIN PASSWORD 'sc_ctl_pw' IN ROLE app_ctlplane; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_auth_login') THEN CREATE ROLE sc_auth_login LOGIN PASSWORD 'sc_auth_pw' IN ROLE app_auth; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_adm_login') THEN CREATE ROLE sc_adm_login LOGIN PASSWORD 'sc_adm_pw' IN ROLE app_admin; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_runtime, app_ctlplane, app_auth, app_admin;
-- The runtime: the tables the code under test touches (Notification for the alerts), as in Production.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
-- The control plane, as Production (20261003090000): Business id and name only; append the audit.
GRANT SELECT ("id", "name") ON "Business" TO app_ctlplane;
GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_ctlplane;
-- The admin console reads Business (id, name) and the audit.
GRANT SELECT ("id", "name") ON "Business" TO app_admin;
GRANT SELECT ON "PlatformAuditEvent" TO app_admin;
DELETE FROM "User" WHERE "id" IN (930100, 930101);
DELETE FROM "Business" WHERE "id" BETWEEN 930001 AND 930099;
INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") VALUES (930001, 'code lab tester', now() - interval '1 hour', now());
INSERT INTO "User" ("id", "email", "businessId", "role", "updatedAt") VALUES
  (930100, 'admin@lab.invalid', 930001, 'PLATFORM_ADMIN', now()), (930101, 'user@lab.invalid', 930001, 'USER', now());
