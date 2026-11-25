-- Subscriptions stage C — CODE lab: businesses created AFTER the migrations (no subscription record), as new signups.
\set ON_ERROR_STOP 1
DELETE FROM "Business" WHERE "id" BETWEEN 930020 AND 930029;
DELETE FROM "PlatformTrialClaim";
INSERT INTO "Business" ("id", "name", "createdAt", "updatedAt") SELECT g, 'code lab ' || g, now(), now() FROM generate_series(930020, 930029) g;
