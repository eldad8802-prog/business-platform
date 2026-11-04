-- Service Desk foundation labs: what Production has and a `prisma db push` cannot create. Idempotent.
--   D2 cutover-2B 20260902120000   "BillingDocument": ENABLE + FORCE RLS and its three p7pilot_* policies, verbatim.
--                                  The quote → document guard runs as the invoker under exactly this RLS.
-- "Customer" ("businessId", "id") is already added by the Daily Tasks prereq (.dt/prereq.sql), as Production has it.
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
