-- Reversal of 20261126090000_auth_issuer_declaration_link. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code calls the two functions (the application PRs not deployed, or reverted first). It
-- REFUSES while any ISSUER_DECLARATION token exists: the narrower vocabulary cannot hold such a row, and what
-- happens to it is a separate, explicit owner decision — never a side effect of a rollback. Declarations
-- billing already recorded are untouched (they live in billing's tables). The functions and tables of
-- 20261017090000 and 20261102090000 are untouched. It removes its own ledger row in the same transaction, so
-- a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "AuthEmailToken" WHERE "purpose" = 'ISSUER_DECLARATION' OR "bindingSha256" IS NOT NULL) THEN
    RAISE EXCEPTION 'issuer declaration link rollback refused: issuer-declaration tokens exist';
  END IF;
END
$rb$;
DROP FUNCTION public.auth_issuer_declaration_consume(uuid, text, integer, text);
DROP FUNCTION public.auth_issuer_declaration_issue(integer, integer, text, uuid, text);
ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_declaration_binding";
ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_purpose";
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_purpose" CHECK ("purpose" IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LINK_GOOGLE'));
ALTER TABLE "AuthEmailToken" DROP COLUMN "bindingSha256";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link';
COMMIT;
