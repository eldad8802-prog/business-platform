-- sec(C) / M-14(a) — PHASE 3 (PREPARED, NOT A MIGRATION YET): FORCE row-level
-- security on WhatsAppConnection, POSApiKey and ProductUsageEvent.
--
-- ORDER (each step is a separate release; do not collapse them):
--   PR-1  migration 20260926110100 — narrow SECURITY DEFINER lookups (applied by
--         release-migrate).
--   PR-2  code — every per-business access to these tables runs in tenantTx, and the
--         two pre-context lookups use the functions (deployed, verified).
--   PR-3  THIS FILE, copied verbatim into prisma/migrations/2026092611xxxx_sec_c_phase3_rls/
--         migration.sql once PR-2 is live. Applying it BEFORE PR-2 is deployed would
--         break WhatsApp sends/webhooks and POS ingest (context-less reads → 0 rows).
-- Proven in a fresh lab by .secc/sections/phase3.ts (sec-c-tenant-db-ci.yml).
--
-- DECISIONS (see the sec(C) PR body for the full table):
--   WhatsAppConnection  tenant-owned, runtime plane. RLS+FORCE, one tenant policy
--                       (ALL, USING+CHECK on the GUC). Pre-context webhook lookup =
--                       sec_c_whatsapp_business_by_phone_number_id (returns the id only).
--   POSApiKey           tenant-owned, runtime plane. Same shape. Pre-context key lookup
--                       = sec_c_pos_api_key_lookup. Erasure deletes under the tenant GUC.
--   ProductUsageEvent   telemetry. Runtime may only APPEND, and only for the business it
--                       acts for (or an unattributed NULL-business event); it cannot read
--                       events at all. Platform admin reads through p7adm_read.
--   User                NO RLS (login/session/signup resolve users before a tenant
--                       exists); boundary is privilege (E4 column grants) — see
--                       scripts/security/sec-c-grants.sql for the admin column narrowing.
--   PaymentProviderRouting  peer-owned code (lib/services/payments/**): NOT changed here.
--
-- The lookup functions run as their owner. If that owner does not carry BYPASSRLS,
-- FORCE RLS would hide every row from them too; the owner-only SELECT policy below
-- (TO the function owner, resolved from the catalog) keeps them working without
-- granting anything to any application role.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.sec_c_whatsapp_business_by_phone_number_id(text)') IS NULL
     OR to_regprocedure('public.sec_c_pos_api_key_lookup(text)') IS NULL THEN
    RAISE EXCEPTION 'sec_c phase 3 requires migration 20260926110100 (bootstrap lookup functions)';
  END IF;
END
$$;

-- WhatsAppConnection
ALTER TABLE "WhatsAppConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsAppConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sec_c_tenant ON "WhatsAppConnection";
CREATE POLICY sec_c_tenant ON "WhatsAppConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- POSApiKey
ALTER TABLE "POSApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "POSApiKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sec_c_tenant ON "POSApiKey";
CREATE POLICY sec_c_tenant ON "POSApiKey"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Owner-only read for the two SECURITY DEFINER lookups.
DO $$
DECLARE
  o text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO o FROM pg_proc
   WHERE oid = 'public.sec_c_whatsapp_business_by_phone_number_id(text)'::regprocedure;
  EXECUTE 'DROP POLICY IF EXISTS sec_c_definer_lookup ON "WhatsAppConnection"';
  EXECUTE format('CREATE POLICY sec_c_definer_lookup ON "WhatsAppConnection" FOR SELECT TO %I USING (true)', o);
  SELECT pg_get_userbyid(proowner) INTO o FROM pg_proc
   WHERE oid = 'public.sec_c_pos_api_key_lookup(text)'::regprocedure;
  EXECUTE 'DROP POLICY IF EXISTS sec_c_definer_lookup ON "POSApiKey"';
  EXECUTE format('CREATE POLICY sec_c_definer_lookup ON "POSApiKey" FOR SELECT TO %I USING (true)', o);
END
$$;

-- ProductUsageEvent: append-only for the runtime, admin-readable.
ALTER TABLE "ProductUsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductUsageEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sec_c_tenant_append ON "ProductUsageEvent";
CREATE POLICY sec_c_tenant_append ON "ProductUsageEvent" FOR INSERT
  WITH CHECK ("businessId" IS NULL
              OR "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS p7adm_read ON "ProductUsageEvent";
CREATE POLICY p7adm_read ON "ProductUsageEvent" FOR SELECT TO app_admin USING (true);

-- Privilege half (the runtime can no longer read, change or delete telemetry).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "ProductUsageEvent" FROM app_runtime;
    GRANT INSERT ON "ProductUsageEvent" TO app_runtime;
  END IF;
  GRANT SELECT ON "ProductUsageEvent" TO app_admin;
END
$$;

COMMIT;
