-- Accounts Payable — Phase 1a tenant RLS.
--
-- Same contract as the D2/P7 wave migrations: EXPAND-ONLY, idempotent, role-free.
-- INERT wherever the runtime connects as owner/BYPASSRLS; live under the
-- restricted runtime role.
--
-- Every Phase 1a table carries a direct `businessId`, so every policy uses the
-- proven fail-closed predicate — no parent-join is needed anywhere in this set:
--
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
--
-- `NULLIF(..., '')` is what makes it fail CLOSED: with no tenant context the
-- setting is the empty string, the predicate becomes NULL, and NULL is not
-- true — so a query outside a tenant transaction returns nothing rather than
-- everything.

ALTER TABLE "Payee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "Payee";
CREATE POLICY payables_p1a_tenant ON "Payee"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Commitment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Commitment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "Commitment";
CREATE POLICY payables_p1a_tenant ON "Commitment"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Installment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Installment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "Installment";
CREATE POLICY payables_p1a_tenant ON "Installment"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "Payment";
CREATE POLICY payables_p1a_tenant ON "Payment"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAllocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "PaymentAllocation";
CREATE POLICY payables_p1a_tenant ON "PaymentAllocation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PaymentEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentEvidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "PaymentEvidence";
CREATE POLICY payables_p1a_tenant ON "PaymentEvidence"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PayablesAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayablesAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "PayablesAuditEvent";
CREATE POLICY payables_p1a_tenant ON "PayablesAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
