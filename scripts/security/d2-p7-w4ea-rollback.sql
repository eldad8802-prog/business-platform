-- D2 / P7-W4E-A — full rollback (policies + grants). Restores the pre-W4E-A
-- posture. Never drops roles; preserves every prior wave's substrate.
-- :ROLE = the tenant runtime role for the environment.

DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentAuditEvent";
ALTER TABLE "PaymentAuditEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAuditEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4ea_tenant ON "BusinessPaymentConnection";
ALTER TABLE "BusinessPaymentConnection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BusinessPaymentConnection" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4ea_tenant ON "FinancialEvent";
ALTER TABLE "FinancialEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "FinancialEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentTransaction";
ALTER TABLE "PaymentTransaction" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" DISABLE ROW LEVEL SECURITY;

-- Tenant runtime grants added by W4E-A.
REVOKE ALL PRIVILEGES ON "PaymentTransaction" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "PaymentAuditEvent" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BusinessPaymentConnection" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "FinancialEvent" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "PaymentTransaction_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "PaymentAuditEvent_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BusinessPaymentConnection_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "FinancialEvent_id_seq" FROM :ROLE;

-- PaymentRequest: W4E-A added INSERT/UPDATE on top of the P4-B pilot's SELECT.
-- Revoke ONLY what W4E-A added — the pilot grant lineage must survive.
REVOKE INSERT, UPDATE ON "PaymentRequest" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "PaymentRequest_id_seq" FROM :ROLE;

-- Bootstrap grants added by W4E-A.
REVOKE ALL PRIVILEGES ON "PaymentWebhookEvent" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "PaymentProviderRouting" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "PaymentWebhookEvent_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "PaymentProviderRouting_id_seq" FROM :ROLE;

-- PaymentProviderRouting itself is deliberately NOT dropped.
--
-- The migration is expand-only, and the table holds derived routing state that
-- the creation flow keeps writing. Dropping it would be a DESTRUCTIVE rollback
-- of data other code depends on, and re-running the migration would have to
-- rebuild it from PaymentRequest — which only works while those rows still
-- carry providerRequestId. Revoking the grants already removes the runtime's
-- entire access to it, which is what a security rollback needs to achieve; the
-- empty table is inert. A deliberate schema teardown, if ever wanted, belongs
-- in its own reviewed destructive migration, not in a security rollback.
