-- Rollback of 20261110100000_acquisition_resolve_paused_hold — the three v2 resolvers only (v1 is untouched by the
-- migration, so nothing else is restored). SAFE ONLY BEFORE the application PR that calls v2 is deployed: once the
-- routes resolve through v2, dropping it turns every inbound delivery into a 503 (the provider retries; nothing is
-- recorded wrongly, but nothing is recorded at all until the code is rolled back too). Run in one transaction.
BEGIN;
DROP FUNCTION IF EXISTS public.m6_acquisition_resolve_keyed_v2(text, text, text);
DROP FUNCTION IF EXISTS public.m6_acquisition_resolve_public_v2(text, text);
DROP FUNCTION IF EXISTS public.m6_acquisition_resolve_resource_v2(text, text);
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold';
COMMIT;
