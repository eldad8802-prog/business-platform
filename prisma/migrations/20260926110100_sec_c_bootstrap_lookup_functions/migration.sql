-- sec(C) / M-14(a) — narrow pre-context lookups, so WhatsAppConnection and POSApiKey
-- can later be put under FORCE row-level security without breaking the two places
-- that must resolve a tenant BEFORE one is known.
--
-- EXPAND-ONLY. Adds two functions. No table, column, policy or grant on a table
-- changes here; nothing that exists today behaves differently.
--
-- THE TWO BOOTSTRAP LOOKUPS
--   * WhatsApp webhook: Meta's `phone_number_id`  -> which business?
--   * POS ingest:       sha256(API key)           -> which business, which key?
-- Both run with no tenant GUC. Under FORCE RLS a tenant predicate matches zero
-- rows there, so the runtime would need cross-tenant SELECT on the whole table —
-- including the encrypted WhatsApp token columns — just to answer "which tenant".
-- Instead each lookup is a SECURITY DEFINER function that answers ONLY that
-- question: it takes the exact key, returns the tenant id (plus, for POS, the key
-- row id / source / active flag the route already uses) and nothing else. It
-- cannot enumerate, cannot be pattern-matched (equality on a unique column) and
-- never returns a token.
--
-- HARDENING: SET search_path pinned to pg_catalog, public (no pg_temp shadowing);
-- EXECUTE revoked from PUBLIC and granted only to the app_runtime group (if it
-- exists in this database). STABLE, no writes.
--
-- The functions run as their owner (the migrating role). When RLS is later
-- enabled on these tables (prepared: ops/security/sec-c-phase3-rls.sql), that
-- script adds an owner-only SELECT policy so the definer keeps working even if the
-- owner role does not carry BYPASSRLS.

CREATE OR REPLACE FUNCTION public.sec_c_whatsapp_business_by_phone_number_id(p_phone_number_id text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT c."businessId"
    FROM public."WhatsAppConnection" c
   WHERE c."phoneNumberId" = p_phone_number_id
     AND c."status" = 'CONNECTED'
$fn$;

CREATE OR REPLACE FUNCTION public.sec_c_pos_api_key_lookup(p_key_hash text)
RETURNS TABLE (key_id integer, business_id integer, key_source text, key_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT k."id", k."businessId", k."source", k."active"
    FROM public."POSApiKey" k
   WHERE k."keyHash" = p_key_hash
$fn$;

REVOKE ALL ON FUNCTION public.sec_c_whatsapp_business_by_phone_number_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sec_c_pos_api_key_lookup(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.sec_c_whatsapp_business_by_phone_number_id(text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.sec_c_pos_api_key_lookup(text) TO app_runtime;
  END IF;
END
$$;
