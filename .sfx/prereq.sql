-- Production's row-level security on the three tables 20261026090000_payment_settlement_facts builds on, verbatim
-- from the migrations that put it there in Production (a `db push` lab omits it):
--   "PaymentRequest"      20260902120000_d2_cutover2b_pilot_tenant_rls (read / add / change policies)
--   "PaymentTransaction"  20260830120000_d2_p7_w4ea_payments_tenant_rls (parent-join through PaymentRequest)
--   "ExternalTransaction" 20260922130000_payables_p4_p6_outbound_foundation
-- With it the battery proves the fact guard against the isolation the runtime really has: a transaction or a
-- bank line of another business is INVISIBLE to the runtime, not merely different.
ALTER TABLE "PaymentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "PaymentRequest";
CREATE POLICY p7pilot_tenant_read ON "PaymentRequest" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "PaymentRequest";
CREATE POLICY p7pilot_tenant_insert ON "PaymentRequest" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
DROP POLICY IF EXISTS p7pilot_tenant_update ON "PaymentRequest";
CREATE POLICY p7pilot_tenant_update ON "PaymentRequest" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PaymentTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentTransaction";
CREATE POLICY p7w4ea_tenant ON "PaymentTransaction"
  USING (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "ExternalTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "ExternalTransaction";
CREATE POLICY payables_p46_tenant ON "ExternalTransaction"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
