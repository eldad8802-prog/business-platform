-- Platform subscriptions — CODE lab setup (stage B). Run as the owner on a database built by `prisma db push` of the
-- code branch, BEFORE the migration: drops the push-made copies of the two tables (the migration creates the real
-- ones), grants the runtime and control-plane roles what Production gives them on the tables the code touches, and
-- creates the businesses and the admin user the lab expects. The migration and business 930003 come after.
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS "PlatformSubscriptionEvent";
DROP TABLE IF EXISTS "PlatformSubscription";
GRANT USAGE ON SCHEMA public TO app_runtime, app_ctlplane;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
GRANT SELECT ON "Business" TO app_ctlplane;
GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane;
GRANT USAGE ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_ctlplane;
INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") VALUES
  (930001, 'code lab A', now() - interval '1 hour', now()), (930002, 'code lab B', now() - interval '1 hour', now()),
  (930009, '__PLATFORM_SYSTEM__', now() - interval '1 hour', now());
INSERT INTO "User" ("id", "email", "businessId", "role", "updatedAt") VALUES (930100, 'admin@lab.invalid', 930009, 'PLATFORM_ADMIN', now());
