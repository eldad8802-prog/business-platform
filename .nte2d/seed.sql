-- Notifications docs + appointments lab: rows the CURRENT application has already written when migration 20261213090000
-- is released (run as the owner on the PENDING database, NTE2D_SEED=.nte2d/seed.sql). The battery proves each one
-- survived unchanged, reads NULL in the new columns (history is never stamped, so never flagged stuck), and that the
-- application's later writes behave. Synthetic only.
INSERT INTO "Business" ("name", "updatedAt") VALUES ('nte2d-seed', now());
INSERT INTO "User" ("email", "password", "businessId", "updatedAt")
  SELECT 'seed@nte2d.lab', 'x', b."id", now() FROM "Business" b WHERE b."name" = 'nte2d-seed';

-- Documents in every status the pipeline and the review flow write (upload → processing; pipeline → needs_review /
-- failed; approve → approved), one of them "processing" since long before the release (an invocation killed at
-- maxDuration): it must stay unstamped (never flagged on history).
INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt")
  SELECT b."id", 'seed-' || s || '.pdf', 'upload', 'application/pdf', s, TIMESTAMP '2026-10-01 08:00:00'
    FROM "Business" b, (VALUES ('processing'), ('needs_review'), ('failed'), ('approved')) v(s)
   WHERE b."name" = 'nte2d-seed';

-- A user's settings row written by the foundation's settings route (quiet hours changed).
INSERT INTO "NotificationSettings" ("businessId", "userId", "quietHoursEnabled", "quietStartMinute", "quietEndMinute", "updatedAt")
  SELECT u."businessId", u."id", true, 1320, 420, now() FROM "User" u WHERE u."email" = 'seed@nte2d.lab';
