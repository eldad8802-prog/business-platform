-- D2 / P7-W4E — tenant RLS for the payments + billing-authority cluster,
-- plus the provider->tenant routing bootstrap surface.
--
-- Same contract as prior waves: EXPAND-ONLY, idempotent, role-free. INERT
-- under owner/BYPASSRLS runtimes (production today); enforcing under the
-- Preview least-privilege runtime role.
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- 0. Provider -> tenant ROUTING INDEX (BOOTSTRAP, deliberately NO RLS)
--
-- A provider callback has no session and no tenant: all it can name is its own
-- (provider, providerRequestId). PaymentRequest is FORCE-RLS'd by the P4-B
-- pilot, so a pre-context lookup there returns zero rows and the callback can
-- never resolve its business — the payments webhooks are fail-closed today.
-- This table is the minimum surface that closes the gap: routing columns only.
-- No amount, no customer, no description, no payload. Same doctrine as
-- WhatsAppConnection.phoneNumberId (docs/security-d2-provider-bootstrap-allowlist-v1.md).
--
-- The rejected alternative was a SECURITY DEFINER resolver function over
-- PaymentRequest: it needs no new table, but it introduces a privilege-
-- escalation surface into the security substrate, which a routing index does not.
-- ============================================================

CREATE TABLE IF NOT EXISTS "PaymentProviderRouting" (
  "id" SERIAL PRIMARY KEY,
  "provider" "PaymentProvider" NOT NULL,
  "providerRequestId" TEXT NOT NULL,
  "paymentRequestId" INTEGER NOT NULL,
  "businessId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentProviderRouting_paymentRequestId_key"
  ON "PaymentProviderRouting"("paymentRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentProviderRouting_provider_providerRequestId_key"
  ON "PaymentProviderRouting"("provider", "providerRequestId");
CREATE INDEX IF NOT EXISTS "PaymentProviderRouting_businessId_idx"
  ON "PaymentProviderRouting"("businessId");

-- Backfill routing rows for payment requests that already have a provider id.
-- Expand-only and idempotent: inserts nothing that already routes.
INSERT INTO "PaymentProviderRouting" ("provider", "providerRequestId", "paymentRequestId", "businessId")
SELECT p."provider", p."providerRequestId", p."id", p."businessId"
  FROM "PaymentRequest" p
 WHERE p."providerRequestId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "PaymentProviderRouting" r WHERE r."paymentRequestId" = p."id"
   )
ON CONFLICT DO NOTHING;

-- ============================================================
-- 1. Direct tenancy (businessId column) — 9 tables
-- ============================================================

ALTER TABLE "PaymentAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "PaymentAuditEvent";
CREATE POLICY p7w4e_tenant ON "PaymentAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessPaymentConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessPaymentConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BusinessPaymentConnection";
CREATE POLICY p7w4e_tenant ON "BusinessPaymentConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "FinancialEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "FinancialEvent";
CREATE POLICY p7w4e_tenant ON "FinancialEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingPaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingPaymentAllocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingPaymentAllocation";
CREATE POLICY p7w4e_tenant ON "BillingPaymentAllocation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingDocumentNumberSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentNumberSequence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingDocumentNumberSequence";
CREATE POLICY p7w4e_tenant ON "BillingDocumentNumberSequence"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingAuditEvent";
CREATE POLICY p7w4e_tenant ON "BillingAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingAuthorityConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthorityConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingAuthorityConnection";
CREATE POLICY p7w4e_tenant ON "BillingAuthorityConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingAuthoritySubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthoritySubmission" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingAuthoritySubmission";
CREATE POLICY p7w4e_tenant ON "BillingAuthoritySubmission"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessBot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BusinessBot";
CREATE POLICY p7w4e_tenant ON "BusinessBot"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- 2. Indirect tenancy (parent-join through an RLS-protected parent) — 3 tables
--
-- PaymentRequest and BillingDocument are both FORCE-RLS'd by the P4-B pilot,
-- so the EXISTS subquery — which runs as the querying role — can only see a
-- parent row under the same GUC. These predicates COMPOSE with the pilot
-- policies; they never bypass them.
-- ============================================================

ALTER TABLE "PaymentTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "PaymentTransaction";
CREATE POLICY p7w4e_tenant ON "PaymentTransaction"
  USING (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BillingDocumentLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingDocumentLine";
CREATE POLICY p7w4e_tenant ON "BillingDocumentLine"
  USING (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingDocumentLine"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingDocumentLine"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BillingReceiptPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingReceiptPayment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4e_tenant ON "BillingReceiptPayment";
CREATE POLICY p7w4e_tenant ON "BillingReceiptPayment"
  USING (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingReceiptPayment"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingReceiptPayment"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- 3. No admin read policies in W4E.
--
-- Verified firsthand: no admin-client consumer reads any W4E table.
-- platform-overview reads BillingDocument (already granted + p7adm_read in W2);
-- platform-business-detail reads BillingDocument on the documented CI-4 legacy
-- ratchet. Adding p7adm_read to payment/authority credential tables without a
-- consumer would be pure attack surface, so none is created.
--
-- PaymentWebhookEvent stays BOOTSTRAP/GLOBAL by ratified decision: it has no
-- businessId, is written before any tenant is known, and already carries
-- DB-level idempotency on (provider, providerEventId).
-- ============================================================
