-- Reversal of 20261102090000_oauth_identity_link. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code calls the six functions (the application PR not deployed, or reverted first). It
-- REFUSES while any LINK_GOOGLE token exists: the narrower vocabulary cannot hold such a row, and what
-- happens to it is a separate, explicit owner decision — never a side effect of a rollback. Identities
-- already linked stay (they are ordinary UserIdentity rows; 20261030090000 owns them). The functions and
-- tables of 20261017090000, 20261030090000 and 20261101090000 are untouched. It removes its own ledger row
-- in the same transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "AuthEmailToken" WHERE "purpose" = 'LINK_GOOGLE' OR "oauthTicketId" IS NOT NULL) THEN
    RAISE EXCEPTION 'oauth identity link rollback refused: link tokens exist';
  END IF;
END
$rb$;
DROP FUNCTION public.auth_oauth_identity_unlink(integer);
DROP FUNCTION public.auth_oauth_identity_status(integer);
DROP FUNCTION public.auth_oauth_identity_link(uuid, integer, text);
DROP FUNCTION public.auth_oauth_link_email_consume(uuid, text, uuid);
DROP FUNCTION public.auth_oauth_link_email_check(uuid, text, text);
DROP FUNCTION public.auth_oauth_link_email_issue(text, uuid, text);
DROP INDEX "AuthEmailToken_oauthTicketId_idx";
ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_oauthTicketId_fkey";
ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_oauth_ticket";
ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_purpose";
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_purpose" CHECK ("purpose" IN ('EMAIL_VERIFY', 'PASSWORD_RESET'));
ALTER TABLE "AuthEmailToken" DROP COLUMN "oauthTicketId";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link';
COMMIT;
