-- Notification engine activation lab: what Production could already hold when migration 20261212090000 is released
-- (run as the owner on the PENDING database, NTE2C_SEED=.nte2c/seed.sql): one business with the engine override
-- ENABLED (written by the platform admin after 2b, before 2c — no trigger yet), one DISABLED, one INHERIT. The
-- battery proves the backfill: exactly the ENABLED one gets an activation row, dated at the release (never earlier),
-- so nothing it owed before the release is pushed. Synthetic only.
INSERT INTO "Business" ("name", "updatedAt") VALUES ('nte2c-seed-on', now()), ('nte2c-seed-off', now()), ('nte2c-seed-inherit', now());
INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
  SELECT b."id", 'notifications_engine',
         (CASE b."name" WHEN 'nte2c-seed-on' THEN 'ENABLED' WHEN 'nte2c-seed-off' THEN 'DISABLED' ELSE 'INHERIT' END)::"BusinessFeatureAccessState",
         TIMESTAMP '2026-11-01 08:00:00'
    FROM "Business" b WHERE b."name" IN ('nte2c-seed-on', 'nte2c-seed-off', 'nte2c-seed-inherit');
