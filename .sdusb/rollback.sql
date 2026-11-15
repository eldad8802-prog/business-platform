-- Rollback of 20261124090000_service_user_same_business_fix (LAB / owner-approved only; never run without approval).
--
-- Restores public.service_user_same_business() to the 20261112090000_service_desk_foundation text byte for byte
-- (CREATE OR REPLACE: same oid, so the 14 Production triggers — and any Draft trigger — keep pointing at it), keeps
-- PUBLIC without EXECUTE, and removes the ledger row so `prisma migrate deploy` would apply the fix again.
-- Idempotent: running it twice leaves the same state.
--
-- What it cannot undo (nothing to undo by design): user columns that were set to NULL because a user was deleted while
-- the fix was in place stay NULL — that is the foreign key's ON DELETE SET NULL, the intended result, and the deleted
-- "User" rows are gone. The migration itself wrote no row.
-- After a rollback the defect is back: a user named in two columns of one row cannot be deleted.
BEGIN;
CREATE OR REPLACE FUNCTION public.service_user_same_business()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  col text;
  uid integer;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    uid := (to_jsonb(NEW) ->> col)::integer;
    IF uid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZS03',
        MESSAGE = format('SERVICE_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_user_same_business() FROM PUBLIC;
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261124090000_service_user_same_business_fix';
DO $do$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.service_user_same_business()'::regprocedure) <> 'b64faf1eb6700089bf6529ae76542036' THEN
    RAISE EXCEPTION 'rollback: the function is not the 20261112090000 text';
  END IF;
END
$do$;
COMMIT;
