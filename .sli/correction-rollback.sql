-- Rollback of 20261128100000_legal_identity_correction. Run by the table owner, ONLY after the application code that
-- calls the correction functions has been reverted (or never shipped: the feature is OFF until the owner approves it).
-- Data impact: the correction-request history (requests, decisions, who and when) is DROPPED with the table. Applied
-- corrections stay applied — their values live in BusinessProfile, which this does not touch. Export the table first
-- if the history must be kept. 20261128090000 (the lock) is not affected.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TABLE IF EXISTS "LegalIdentityCorrectionRequest";
DROP FUNCTION IF EXISTS public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz);
DROP FUNCTION IF EXISTS public.legal_identity_correction_cancel(integer, integer);
DROP FUNCTION IF EXISTS public.legal_identity_correction_decide(integer, integer, boolean, text);
DROP FUNCTION IF EXISTS public.legal_identity_correction_erase();
DROP FUNCTION IF EXISTS public.legal_identity_correction_guard();
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261128100000_legal_identity_correction';
COMMIT;
