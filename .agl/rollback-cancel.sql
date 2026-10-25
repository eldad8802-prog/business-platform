-- Reversal of 20261101090000_oauth_ticket_cancel. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code calls auth_oauth_ticket_cancel (the application PR not deployed, or reverted
-- first). It REFUSES while any ticket ended CANCELLED: the narrower constraint cannot hold such a row, and
-- what happens to it is a separate, explicit owner decision — never a side effect of a rollback. The six
-- functions and the table of 20261030090000 are untouched. It removes its own ledger row in the same
-- transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "OAuthSignupTicket" WHERE "endedReason" = 'CANCELLED') THEN
    RAISE EXCEPTION 'oauth ticket cancel rollback refused: cancelled tickets exist';
  END IF;
END
$rb$;
DROP FUNCTION public.auth_oauth_ticket_cancel(text, text);
ALTER TABLE "OAuthSignupTicket" DROP CONSTRAINT "OAuthSignupTicket_end";
ALTER TABLE "OAuthSignupTicket" ADD CONSTRAINT "OAuthSignupTicket_end" CHECK (("endedAt" IS NULL) = ("endedReason" IS NULL)
    AND ("endedReason" IS NULL OR "endedReason" IN ('CONSUMED', 'SUPERSEDED')));
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101090000_oauth_ticket_cancel';
COMMIT;
