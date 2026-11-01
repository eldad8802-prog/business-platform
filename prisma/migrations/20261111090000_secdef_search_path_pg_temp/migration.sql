-- SECURITY DEFINER functions: pg_temp searched LAST (docs/security/PERMISSIONS_CONTRACT.md §4).
--
-- Every SECURITY DEFINER function in public was created with `SET search_path = pg_catalog, public` (one with
-- `public` alone). When pg_temp is not named in search_path, PostgreSQL searches the session's temporary schema
-- FIRST for tables. Any session can create a temporary table, so a caller could shadow a public table that the
-- function reads unqualified. Reproduced in the shared security lab as the runtime role: a temporary "Business"
-- (marked as being deleted) let accountant_erase_business() pass its "the business is being deleted" check for a
-- business that was not, and scrub actorUserId from that business's append-only accountant trail.
--
-- Fix, with no change to any function body, owner or caller:
--   * search_path = pg_catalog, public, pg_temp on all 40 SECURITY DEFINER functions (pg_temp last: never shadows);
--   * content_variant_same_tenant() is a trigger function with search_path = public only and EXECUTE for PUBLIC:
--     same search_path, and EXECUTE revoked from PUBLIC (a trigger fires without the caller's EXECUTE privilege).
-- The final block fails the migration if any SECURITY DEFINER function in public is left without pg_temp last.

ALTER FUNCTION public.accountant_delivery_by_provider_message(p_provider text, p_message_id text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.accountant_erase_business() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.accountant_link_resolve(p_public_id text, p_token_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.appointment_erase_business() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_email_token_check(p_token_id uuid, p_secret text, p_purpose text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_email_token_issue(p_user_id integer, p_purpose text, p_token_id uuid, p_token_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_email_verify_consume(p_token_id uuid, p_secret text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_identity_attach(p_ticket_id uuid, p_user_id integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_identity_link(p_ticket_id uuid, p_user_id integer, p_proof text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_identity_resolve(p_provider text, p_subject text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_identity_status(p_user_id integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_identity_unlink(p_user_id integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_link_email_check(p_token_id uuid, p_secret text, p_ticket_secret text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_link_email_consume(p_token_id uuid, p_secret text, p_ticket_id uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_link_email_issue(p_ticket_secret text, p_token_id uuid, p_token_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_ticket_cancel(p_secret text, p_purpose text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_ticket_consume(p_secret text, p_purpose text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_ticket_issue(p_purpose text, p_provider text, p_subject text, p_email text, p_name text, p_email_verified boolean, p_secret_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_ticket_purge() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_oauth_ticket_read(p_secret text, p_purpose text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.auth_password_reset_consume(p_token_id uuid, p_secret text, p_password_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.booking_pending_due(p_now timestamp without time zone, p_limit integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.booking_resolve_manage_token(p_token_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.booking_resolve_public(p_public_id text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.content_variant_same_tenant() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.document_supplier_link_erase_business() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.m6_acquisition_resolve_keyed(p_source_key text, p_public_id text, p_key_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.m6_acquisition_resolve_public(p_source_key text, p_public_id text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.m6_acquisition_resolve_resource(p_source_key text, p_resource_id text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.m6_acquisition_tenants(p_source_key text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sec_c_pos_api_key_lookup(p_key_hash text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sec_c_whatsapp_business_by_phone_number_id(p_phone_number_id text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_reminders_due(p_now timestamp without time zone, p_limit integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_clear_event_digests() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_clear_source_identifiers() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_days(p_kind text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_erase_business() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_purge_learning_events() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_purge_request_ledger() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.task_retention_purge_source_state() SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.content_variant_same_tenant() FROM PUBLIC;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
     AND coalesce(array_to_string(p.proconfig, ';'), '') NOT LIKE '%search_path=pg_catalog, public, pg_temp%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions without pg_temp last in search_path: %', bad;
  END IF;
END $$;
