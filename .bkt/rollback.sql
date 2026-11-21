-- Rollback of 20261221090000_business_kind_transition. Run by the table owner, ONLY after the application code that
-- calls business_kind_transition_to_authorized has been reverted (the route would otherwise answer 500).
-- Data impact: the transition HISTORY is dropped. A business that already transitioned stays AUTHORIZED_DEALER with
-- its VAT number (the profile is not reverted: documents issued since then carry that kind in their snapshot). Take a
-- copy of "BusinessKindTransition" first if any row exists.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text);
DROP FUNCTION IF EXISTS public.business_kind_transition_statement(integer, integer, text, text, text, date);
DROP TABLE IF EXISTS "BusinessKindTransition";
DROP FUNCTION IF EXISTS public.business_kind_transition_append_only();
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261221090000_business_kind_transition';
COMMIT;
