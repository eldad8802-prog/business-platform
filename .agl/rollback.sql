-- Reversal of 20261030090000_oauth_identity_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the tables (the application PR not deployed, or reverted first).
-- It REFUSES while any identity or ticket row exists or any user has no password: an account opened with
-- Google cannot be put back under a NOT NULL password without deciding what happens to it, and that is a
-- separate, explicit owner decision — never a side effect of a rollback. It removes its own ledger row in
-- the same transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "UserIdentity") OR EXISTS (SELECT 1 FROM "OAuthSignupTicket")
     OR EXISTS (SELECT 1 FROM "User" WHERE "password" IS NULL) THEN
    RAISE EXCEPTION 'oauth identity rollback refused: rows exist';
  END IF;
END
$rb$;
DROP FUNCTION public.auth_oauth_ticket_purge();
DROP FUNCTION public.auth_oauth_identity_resolve(text, text);
DROP FUNCTION public.auth_oauth_identity_attach(uuid, integer);
DROP FUNCTION public.auth_oauth_ticket_consume(text, text);
DROP FUNCTION public.auth_oauth_ticket_read(text, text);
DROP FUNCTION public.auth_oauth_ticket_issue(text, text, text, text, text, boolean, text);
DROP TABLE "OAuthSignupTicket";
DROP TABLE "UserIdentity";
ALTER TABLE "User" ALTER COLUMN "password" SET NOT NULL;
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261030090000_oauth_identity_foundation';
COMMIT;
