-- Leads L1.5-a · decision 3 (owner, 2026-11-04): a PAUSED connection keeps RECEIVING verified deliveries — they are
-- recorded and held (never processed while paused) — instead of being refused (keyed / public endpoints: 401, which
-- Google never retries) or acknowledged and dropped (Meta Page / Wix installation: 200, skipped).
--
-- WHAT THIS ADDS (additive only — nothing existing is altered or dropped)
--   m6_acquisition_resolve_keyed_v2(source, publicId, keyHash)   ACTIVE or PAUSED, + the connection status
--   m6_acquisition_resolve_public_v2(source, publicId)           ACTIVE or PAUSED, + allowed origins + status
--   m6_acquisition_resolve_resource_v2(source, resourceId)       ACTIVE, ERROR or PAUSED, + status
--
-- The v1 functions stay EXACTLY as they are, so applying this migration changes no behaviour: the running code keeps
-- calling v1 until the application PR (migration-first) switches each route to v2 and, for a PAUSED status, holds the
-- receipt (the processor re-checks the connection before every attempt; nothing is released while it is paused).
--
-- UNCHANGED BOUNDARIES
--   REVOKED never resolves (no live mapping); ERROR still does not resolve on the keyed / public endpoints (not part of
--   decision 3); the lookup is by equality on a unique value only — no enumeration, no businessId from the request.
--   Same owner, same SECURITY DEFINER pattern, EXECUTE revoked from PUBLIC and granted to app_runtime only.
--   search_path pins pg_temp last (the hardened form proposed in #905).

CREATE FUNCTION public.m6_acquisition_resolve_keyed_v2(p_source_key text, p_public_id text, p_key_hash text)
RETURNS TABLE (connection_id integer, business_id integer, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c."id", c."businessId", c."status"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."publicId" = p_public_id
     AND c."keyHash" = p_key_hash
     AND c."status" IN ('ACTIVE', 'PAUSED')
$fn$;

CREATE FUNCTION public.m6_acquisition_resolve_public_v2(p_source_key text, p_public_id text)
RETURNS TABLE (connection_id integer, business_id integer, allowed_origins text[], status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c."id", c."businessId", c."allowedOrigins", c."status"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."publicId" = p_public_id
     AND c."status" IN ('ACTIVE', 'PAUSED')
$fn$;

CREATE FUNCTION public.m6_acquisition_resolve_resource_v2(p_source_key text, p_resource_id text)
RETURNS TABLE (connection_id integer, business_id integer, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c."id", c."businessId", c."status"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."externalResourceId" = p_resource_id
     AND c."status" IN ('ACTIVE', 'ERROR', 'PAUSED')
$fn$;

REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_keyed_v2(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_public_v2(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m6_acquisition_resolve_resource_v2(text, text) FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_keyed_v2(text, text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_public_v2(text, text) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.m6_acquisition_resolve_resource_v2(text, text) TO app_runtime;
  END IF;
END
$do$;
