-- D2 / P7-W4E-B-2 — full rollback (policies + grants). Restores the pre-B-2
-- posture. Never drops roles; preserves every prior wave.
-- :ROLE = the tenant runtime role for the environment.
--
-- IMPORTANT: this rolls back the DB ENFORCEMENT only. It does NOT and must not
-- touch the W4E-B-1 trust repair — the signed OAuth state, the removal of
-- cookie tenant authority, and the tenant threading are application-layer
-- correctness that stands on its own and is strictly safer than what preceded
-- it. Reverting policies must never be a reason to reopen that hole.

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuthorityConnection";
ALTER TABLE "BillingAuthorityConnection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthorityConnection" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuthoritySubmission";
ALTER TABLE "BillingAuthoritySubmission" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthoritySubmission" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingPaymentAllocation";
ALTER TABLE "BillingPaymentAllocation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingPaymentAllocation" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingDocumentNumberSequence";
ALTER TABLE "BillingDocumentNumberSequence" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentNumberSequence" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuditEvent";
ALTER TABLE "BillingAuditEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuditEvent" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BusinessBot";
ALTER TABLE "BusinessBot" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBot" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingDocumentLine";
ALTER TABLE "BillingDocumentLine" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentLine" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingReceiptPayment";
ALTER TABLE "BillingReceiptPayment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BillingReceiptPayment" DISABLE ROW LEVEL SECURITY;

-- Grants added by W4E-B-2.
REVOKE ALL PRIVILEGES ON "BillingAuthorityConnection" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingAuthoritySubmission" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingPaymentAllocation" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingDocumentNumberSequence" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingAuditEvent" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BusinessBot" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingDocumentLine" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BillingReceiptPayment" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingAuthorityConnection_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingAuthoritySubmission_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingPaymentAllocation_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingDocumentNumberSequence_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingAuditEvent_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BusinessBot_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingDocumentLine_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingReceiptPayment_id_seq" FROM :ROLE;

-- BillingDocument: W4E-B-2 added INSERT/UPDATE on top of the P4-B pilot's
-- SELECT. Revoke ONLY what this wave added — the pilot grant lineage, and the
-- pilot's own p4b_tenant policy, must survive untouched.
REVOKE INSERT, UPDATE ON "BillingDocument" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BillingDocument_id_seq" FROM :ROLE;

-- Not touched by design: p4b_tenant on BillingDocument (pilot),
-- p7w4b_tenant on BusinessBotSettings (W4B), p7w4ea_tenant (W4E-A), every
-- earlier wave's policies and grants, and all persistent roles.
