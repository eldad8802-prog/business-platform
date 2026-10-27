-- Rows that exist BEFORE migration 20261106090000 (run on a lab built by `.bkg/lab.sh <db>`, then `--deploy-only`):
-- a business with two staff members and booking settings, so the battery can show existing rows keep their values and
-- take the safe defaults. Synthetic only.
WITH b AS (INSERT INTO "Business" (name, "updatedAt") VALUES ('bkg-pre-A', now()) RETURNING id)
INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt")
SELECT id, n, now() FROM b, (VALUES ('דנה'), ('יוסי')) AS v(n);
INSERT INTO "BookingSettings" ("businessId", enabled, "publicId", "updatedAt")
SELECT id, true, 'bkgPublicIdPreA_0123456789AB', now() FROM "Business" WHERE name = 'bkg-pre-A';
