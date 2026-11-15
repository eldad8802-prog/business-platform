-- Rollback of 20261130090000_service_handover_debt_record — only for a failed or abandoned rollout, run by the migration
-- owner in ONE transaction, BEFORE any product code writes a version-2 handover (the code PR merges only after the
-- migration). It REFUSES when anything this migration added holds data (a version-2 handover, a non-NULL new column):
-- then data would be lost, and the owner decides instead. Version-1 (legacy) handovers are untouched by the rollback:
-- their new columns are NULL / the default and simply go away.
-- service_handover_guard is restored to its 20261112090000 text (below, verbatim — copied from that migration); the
-- same-business trigger to its foundation argument list. service_completion_guard is not touched: the migration no longer
-- replaces it (approver = actor is M1's own rule, 20261127090000). The ledger
-- row is removed in the same transaction, so a later `prisma migrate deploy` applies the migration again.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceHandover" WHERE "recordVersion" <> 1 OR "overpaidAgorot" IS NOT NULL
               OR "debtApprovedByUserId" IS NOT NULL OR "debtApprovedAt" IS NOT NULL
               OR "loanerApprovedByUserId" IS NOT NULL OR "loanerApprovedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a handover uses a column of this migration (a version-2 record); nothing was changed';
  END IF;
END
$do$;

DROP TRIGGER "ServiceHandover_record_guard" ON "ServiceHandover";
DROP FUNCTION public.service_handover_record_guard();
DROP FUNCTION public.service_handover_record_erase_business();
DROP TRIGGER "ServiceHandover_user_same_business" ON "ServiceHandover";
CREATE TRIGGER "ServiceHandover_user_same_business"
  BEFORE INSERT ON "ServiceHandover"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- verbatim 20261112090000_service_desk_foundation section 9.9
CREATE OR REPLACE FUNCTION public.service_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  erasable constant text[] := ARRAY['receivedByName', 'signatureKey', 'debtOverrideReason', 'loanerOverrideReason', 'actorUserId', 'erasedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF in_erasure
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."receivedByName" IS NULL AND NEW."signatureKey" IS NULL AND NEW."debtOverrideReason" IS NULL
       AND NEW."loanerOverrideReason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_HANDOVER_FIXED: %s on %I is refused; a handover is a permanent record', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_handover_guard() FROM PUBLIC;

ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_debtApprovedByUserId_fkey";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_loanerApprovedByUserId_fkey";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_record_version";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_legacy_shape";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_balance";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_debt_decided";
ALTER TABLE "ServiceHandover" DROP CONSTRAINT "ServiceHandover_loaner_decided";
ALTER TABLE "ServiceHandover"
  DROP COLUMN "recordVersion", DROP COLUMN "overpaidAgorot", DROP COLUMN "debtApprovedByUserId", DROP COLUMN "debtApprovedAt",
  DROP COLUMN "loanerApprovedByUserId", DROP COLUMN "loanerApprovedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261130090000_service_handover_debt_record';
COMMIT;
