-- D2 / P7-W4E-A — tenant RLS for the payments cluster, plus the provider->tenant
-- routing bootstrap surface.
--
-- SCOPE NOTE: W4E was authorized as "payments + billing authority". Live Preview
-- reconnaissance showed the billing half is a wave of its own — BillingDocument
-- is already FORCE-RLS'd by the P4-B pilot with SELECT-only runtime grants while
-- all 18 billing routes still run with no tenant context, so billing needs its
-- own end-to-end wiring pass (18 routes, ~15 services, legal document numbering,
-- credit/reversal state machine) before any of its tables may be protected.
-- Protecting unwired tables would harden a module into a harder failure, so
-- W4E-A covers exactly what is fully wired and proven. Billing + the ITA
-- authority OAuth trust rework are W4E-B.
--
-- Same contract as prior waves: EXPAND-ONLY, idempotent, role-free. INERT under
-- owner/BYPASSRLS runtimes (production today); enforcing under the Preview
-- least-privilege runtime role.
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

-- Backfill routing rows for payment requests that already carry a provider id.
-- Expand-only and idempotent: inserts nothing that already routes, and the
-- unique index means two tenants can never claim one provider reference.
INSERT INTO "PaymentProviderRouting" ("provider", "providerRequestId", "paymentRequestId", "businessId")
SELECT p."provider", p."providerRequestId", p."id", p."businessId"
  FROM "PaymentRequest" p
 WHERE p."providerRequestId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "PaymentProviderRouting" r WHERE r."paymentRequestId" = p."id"
   )
ON CONFLICT DO NOTHING;

-- ============================================================
-- 1. Direct tenancy (businessId column) — 3 tables
-- ============================================================

ALTER TABLE "PaymentAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentAuditEvent";
CREATE POLICY p7w4ea_tenant ON "PaymentAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessPaymentConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessPaymentConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4ea_tenant ON "BusinessPaymentConnection";
CREATE POLICY p7w4ea_tenant ON "BusinessPaymentConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "FinancialEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4ea_tenant ON "FinancialEvent";
CREATE POLICY p7w4ea_tenant ON "FinancialEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- 2. Indirect tenancy (parent-join through an RLS-protected parent) — 1 table
--
-- PaymentRequest is FORCE-RLS'd by the P4-B pilot, so the EXISTS subquery —
-- which runs as the querying role — can only see a parent row under the same
-- GUC. This predicate COMPOSES with the pilot policy; it never bypasses it.
-- ============================================================

ALTER TABLE "PaymentTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4ea_tenant ON "PaymentTransaction";
CREATE POLICY p7w4ea_tenant ON "PaymentTransaction"
  USING (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = "PaymentTransaction"."paymentRequestId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- 3. No admin read policies in W4E-A.
--
-- Verified firsthand: no admin-client consumer reads any W4E-A table.
-- platform-overview reads BillingDocument (already granted + p7adm_read in W2);
-- platform-business-detail reads BillingDocument on the documented CI-4 legacy
-- ratchet. Granting admin read of payment credentials or audit trails without a
-- consumer would be pure attack surface, so none is created.
--
-- PaymentWebhookEvent stays BOOTSTRAP/GLOBAL by ratified decision: it has no
-- businessId, is written before any tenant is known, and already carries
-- DB-level idempotency on (provider, providerEventId).
-- ============================================================

-- ============================================================
-- 4. DB-level settlement idempotency on PaymentTransaction.
--
-- The webhook guarded duplicate settlements with a read-then-write check
-- (findTransactionByProviderTransactionId, then create). The W4E-A battery
-- broke that under concurrent provider callbacks: two transactions for one
-- payment request, and a second FinancialEvent behind it. A provider's
-- transaction id is unique per provider by definition, so the guarantee
-- belongs in the database, not in the service.
--
-- NULL is distinct in Postgres, so rows with no provider transaction id
-- (unverified / signal-only providers) are unaffected.
--
-- Legacy safety: if duplicates already exist the index cannot be created, and
-- guessing which row to keep would be a data decision this migration has no
-- authority to make — so it fails LOUDLY with an actionable message instead.
-- ============================================================

DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "provider", "providerTransactionId"
      FROM "PaymentTransaction"
     WHERE "providerTransactionId" IS NOT NULL
     GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'W4E-A: % duplicate (provider, providerTransactionId) group(s) already exist in PaymentTransaction. Reconcile them deliberately before applying settlement idempotency — this migration will not choose a winner.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_provider_providerTransactionId_key"
  ON "PaymentTransaction"("provider", "providerTransactionId");
