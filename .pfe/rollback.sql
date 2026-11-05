-- Rollback of 20261114090000_platform_feature_emergency_switch — the one function (no table, grant or state is touched
-- by the migration, so nothing else is restored). The switch states are left exactly as they are: if a switch is ON
-- when this runs, it stays ON (turning it off is a decision, not a rollback) and the admin tool stops working.
BEGIN;
DROP FUNCTION IF EXISTS public.platform_set_feature_emergency(text, boolean, integer, text, text, text);
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261114090000_platform_feature_emergency_switch';
COMMIT;
