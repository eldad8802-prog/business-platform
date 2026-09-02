-- D2 / PRODUCTION-RUNTIME-CUTOVER-2B — rollback for the five-pilot tenant RLS.
--
-- Removes ONLY the policies this wave owns (`p7pilot_tenant_*`) and returns the five
-- tables to their pre-migration RLS flags. It deliberately does NOT touch:
--
--   * `p7adm_read` on Conversation / BillingDocument — canonical since
--     20260825090000_d2_p7_w2gate_admin_read and owned by that wave;
--   * any grant, role or ownership — this wave changes none of them;
--   * any row — no data is read or written.
--
-- It also does NOT restore Preview's `p4b_tenant`. That policy was never a repository
-- artifact; it was applied by hand to one branch and is exactly the divergence the
-- migration exists to remove. Recreating it on rollback would reintroduce the
-- accidental `FOR ALL` DELETE capability.
--
-- Rolling back REMOVES tenant isolation from these five tables. It is safe with
-- respect to data and reversible, but it reopens the boundary — under a restricted
-- runtime the tables would fall back to grant-only protection, and under the current
-- owner runtime they would simply be unprotected again.

ALTER TABLE "Conversation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "Conversation";
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Conversation";
DROP POLICY IF EXISTS p7pilot_tenant_update ON "Conversation";

ALTER TABLE "Customer" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Customer" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "Customer";
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Customer";
DROP POLICY IF EXISTS p7pilot_tenant_update ON "Customer";

ALTER TABLE "Appointment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "Appointment";
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Appointment";
DROP POLICY IF EXISTS p7pilot_tenant_update ON "Appointment";

ALTER TABLE "BillingDocument" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocument" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "BillingDocument";
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "BillingDocument";
DROP POLICY IF EXISTS p7pilot_tenant_update ON "BillingDocument";

ALTER TABLE "PaymentRequest" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentRequest" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7pilot_tenant_read ON "PaymentRequest";
DROP POLICY IF EXISTS p7pilot_tenant_insert ON "PaymentRequest";
DROP POLICY IF EXISTS p7pilot_tenant_update ON "PaymentRequest";
