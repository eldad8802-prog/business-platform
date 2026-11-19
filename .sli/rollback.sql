-- Rollback of 20261128090000_signup_legal_identity. Run by the table owner, ONLY after the application code that
-- calls signup_legal_identity_seed has been reverted (otherwise every signup fails closed).
-- Data impact: none on identity values (they stay in the billing* columns, where billing reads them); only the
-- confirmation markers are dropped, so every business becomes editable as before the migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TRIGGER IF EXISTS "BusinessProfile_legal_identity_lock" ON "BusinessProfile";
DROP TRIGGER IF EXISTS "BusinessProfile_legal_identity_insert" ON "BusinessProfile";
DROP TRIGGER IF EXISTS "BusinessProfile_legal_identity_no_delete" ON "BusinessProfile";
DROP FUNCTION IF EXISTS public.legal_identity_lock();
DROP FUNCTION IF EXISTS public.legal_identity_no_delete();
DROP FUNCTION IF EXISTS public.legal_identity_confirm_existing(integer);
DROP FUNCTION IF EXISTS public.signup_legal_identity_seed(integer, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.legal_identity_business_is_being_deleted(integer);
DROP FUNCTION IF EXISTS public.legal_identity_tax_id_ok(text);
ALTER TABLE "BusinessProfile"
  DROP CONSTRAINT IF EXISTS "BusinessProfile_legalIdentity_pair",
  DROP CONSTRAINT IF EXISTS "BusinessProfile_legalIdentitySource_check",
  DROP COLUMN IF EXISTS "legalIdentityConfirmedAt",
  DROP COLUMN IF EXISTS "legalIdentitySource";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261128090000_signup_legal_identity';
COMMIT;
