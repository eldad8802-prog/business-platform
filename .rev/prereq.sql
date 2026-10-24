-- Revenue truth labs: the row-level security Production has on the two existing tables the link guard reads,
-- which the base lab's `db push` builds without it. Verbatim from the migrations that ship it (idempotent):
--   20260902120000_d2_cutover2b_pilot_tenant_rls          "BillingDocument": ENABLE + FORCE RLS, per-command tenant policies
--   20260922130000_payables_p4_p6_outbound_foundation     "ExternalTransaction": ENABLE + FORCE RLS, payables_p46_tenant
-- The platform-admin read policies of 20260825090000_d2_p7_w2gate_admin_read are not replayed: no check here
-- depends on them. With this, the preflight's check 14 meets Production's state, and the link guard and the
-- loader read these tables as the runtime under their real tenant policies.

DROP POLICY IF EXISTS p4b_tenant ON "BillingDocument";

ALTER TABLE "BillingDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocument" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7pilot_tenant_read ON "BillingDocument";
CREATE POLICY p7pilot_tenant_read ON "BillingDocument" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_insert ON "BillingDocument";
CREATE POLICY p7pilot_tenant_insert ON "BillingDocument" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_update ON "BillingDocument";
CREATE POLICY p7pilot_tenant_update ON "BillingDocument" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ExternalTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "ExternalTransaction";
CREATE POLICY payables_p46_tenant ON "ExternalTransaction"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
