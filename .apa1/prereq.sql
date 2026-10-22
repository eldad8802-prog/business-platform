-- Admin Control Center A1 lab: the DB-only objects migration 20261024090000 builds on, exactly as Production
-- has them (a `prisma db push` cannot create them, and the lab ledger baselines the waves that did). Idempotent.
--
--   D2/P7-W2-GATE 20260825090000   the env-neutral NOLOGIN group app_admin
--   the tenant waves               ENABLE + FORCE RLS and the tenant policy on each table the console reads,
--                                  with the policy names Production carries (p7w1/p7w2/p7w4b/p7w4c/p7w4d,
--                                  the cut-over-2b pilot read/insert/update pair)
--   the admin read waves           the ADDITIVE p7adm_read policies on six of them (BusinessProfile is the one
--                                  A1 adds)
-- The runtime's privileges are NOT added here: the lab owner's DEFAULT PRIVILEGES handed them out when
-- `db push` created the tables — the same way Production got them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

-- Single-policy tenant tables (FOR ALL, the GUC both ways).
DO $$
DECLARE
  t text;
  p text;
BEGIN
  FOR t, p IN SELECT * FROM (VALUES
      ('BusinessProfile', 'p7w1_tenant'),
      ('ContentRun', 'p7w2_tenant'),
      ('WhatsAppAttachmentImport', 'p7w4b_tenant'),
      ('EmailConnection', 'p7w4c_tenant'),
      ('Document', 'p7w4d_tenant')) v(t, p)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int) '
      'WITH CHECK ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int)', p, t);
  END LOOP;
END
$$;

-- The cut-over-2b pilot tables carry per-command policies (read / insert / update; no delete policy).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BillingDocument', 'Conversation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS p7pilot_tenant_read ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS p7pilot_tenant_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS p7pilot_tenant_update ON %I', t);
    EXECUTE format('CREATE POLICY p7pilot_tenant_read ON %I FOR SELECT '
      'USING ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int)', t);
    EXECUTE format('CREATE POLICY p7pilot_tenant_insert ON %I FOR INSERT '
      'WITH CHECK ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int)', t);
    EXECUTE format('CREATE POLICY p7pilot_tenant_update ON %I FOR UPDATE '
      'USING ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int) '
      'WITH CHECK ("businessId" = NULLIF(current_setting(''app.current_business_id'', true), '''')::int)', t);
  END LOOP;
END
$$;

-- The six admin read policies that already exist in Production (A1 adds the seventh, on BusinessProfile).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Document', 'BillingDocument', 'Conversation', 'ContentRun', 'EmailConnection',
                           'WhatsAppAttachmentImport'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS p7adm_read ON %I', t);
    EXECUTE format('CREATE POLICY p7adm_read ON %I FOR SELECT TO app_admin USING (true)', t);
  END LOOP;
END
$$;
DROP POLICY IF EXISTS p7adm_read ON "BusinessProfile";
