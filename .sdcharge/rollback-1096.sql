-- Rollback of 20261125090000_service_desk_handover_owner_confirmed — restores the two original handover CHECKs
-- (20261112090000). Only valid while every handover row still satisfies them: it refuses otherwise (a handover made
-- without a signature would violate ServiceHandover_signed — then the owner decides; the data is never changed here).
-- Run by the migration owner in ONE transaction; the ledger row is removed in it, so a later deploy re-applies it.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceHandover" WHERE NOT "signatureCaptured"
               OR NOT (("receivedByName" IS NOT NULL AND btrim("receivedByName") <> '' AND char_length("receivedByName") <= 200)
                       OR ("receivedByName" IS NULL AND "erasedAt" IS NOT NULL))) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a handover row would violate the original CHECKs; nothing was changed';
  END IF;
END
$do$;
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_receiver";
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_signed" CHECK ("signatureCaptured");
ALTER TABLE "ServiceHandover" ADD CONSTRAINT "ServiceHandover_receiver" CHECK (
  ("receivedByName" IS NOT NULL AND btrim("receivedByName") <> '' AND char_length("receivedByName") <= 200)
  OR ("receivedByName" IS NULL AND "erasedAt" IS NOT NULL));
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed';
COMMIT;
