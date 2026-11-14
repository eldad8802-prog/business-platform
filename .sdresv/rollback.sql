-- Rollback of 20261128090000_service_parts_reservation_guard — run by the migration owner in ONE transaction.
--
-- The migration owns no data: two trigger functions and two triggers that only refuse. Removing them loses nothing
-- and is safe at any time, with any rows present; the application keeps releasing reservations inside the cancel's
-- transaction (part-release.ts) exactly as before, only without the database re-check. What this does NOT undo:
-- writes that the guard refused while it was in place stay refused (they were rolled back whole, nothing to restore).
-- The ledger row is removed in the same transaction, so a later `prisma migrate deploy` applies the migration again
-- (`migrate resolve` only handles a FAILED migration). Idempotent: a second run changes nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS "ServicePart_takes_stock_on_live_case" ON "ServicePart";
DROP TRIGGER IF EXISTS "ServiceCase_parts_released_on_cancel" ON "ServiceCase";
DROP FUNCTION IF EXISTS public.service_part_takes_stock_guard();
DROP FUNCTION IF EXISTS public.service_case_parts_released_on_cancel();
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261128090000_service_parts_reservation_guard';
COMMIT;
