-- Reversal of 20261017090000_auth_email_tokens. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the table or the column (the application PR not deployed, or
-- reverted first). It REFUSES while any token row exists or any user is marked verified: a verified address
-- is a fact an owner proved, and discarding it is a separate, explicit owner decision — never a side effect
-- of a rollback. It removes its own ledger row in the same transaction, so a later release re-applies it
-- whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "AuthEmailToken") OR EXISTS (SELECT 1 FROM "User" WHERE "emailVerifiedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'auth email tokens rollback refused: rows exist';
  END IF;
END
$rb$;
DROP FUNCTION public.auth_password_reset_consume(uuid, text, text);
DROP FUNCTION public.auth_email_verify_consume(uuid, text);
DROP FUNCTION public.auth_email_token_check(uuid, text, text);
DROP FUNCTION public.auth_email_token_issue(integer, text, uuid, text);
DROP TABLE "AuthEmailToken";
ALTER TABLE "User" DROP COLUMN "emailVerifiedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261017090000_auth_email_tokens';
COMMIT;
