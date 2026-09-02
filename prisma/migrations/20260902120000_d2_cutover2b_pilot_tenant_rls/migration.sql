-- D2 / PRODUCTION-RUNTIME-CUTOVER-2B — canonical tenant RLS for the five original
-- P4-B pilot tables.
--
-- WHY THIS EXISTS
-- The P4-B "pilot" enabled FORCE RLS on Conversation, Customer, Appointment,
-- BillingDocument and PaymentRequest by hand, directly on the Preview branch. It was
-- never shipped as a migration. Every later P7 wave was then written on top of that
-- assumption — W4E-A says "PaymentRequest is FORCE-RLS'd by the P4-B pilot" and
-- W4E-B-2 says the same of BillingDocument — while Production, which only ever sees
-- repository migrations, has had no RLS on any of the five. Preview looked protected;
-- Production was not; nothing in the repository could tell you which was right.
--
-- This migration makes the repository the authority. After it, a clean repo-derived
-- database and Preview converge on the same definitions, and Production can be
-- brought to that same state through the normal gated path.
--
-- DELETE IS DELIBERATELY ABSENT
-- The Preview residue policy is `FOR ALL`, which silently includes DELETE. That is
-- more permissive than anything the product needs. Auditing every runtime path found
-- exactly ONE delete against any of these five tables — `conversation.deleteMany` in
-- the account-erasure store — and that is a separate privileged boundary whose
-- authority has NOT been granted (AD-2A shipped no DELETE capability, and the erasure
-- is known to be refused under the restricted runtime, fail-closed and retryable).
-- So the tenant policies below are split per command: SELECT, INSERT and UPDATE only.
-- No DELETE policy is created for any of the five. A policy must not be written just
-- because the syntax allows it, and `FOR ALL` is how a DELETE capability gets granted
-- by accident.
--
-- NOTE ON GRANTS: `app_runtime` currently holds a DELETE grant on all five tables
-- through historical broad grants. A table grant is not a policy — with no DELETE
-- policy and FORCE RLS, the delete still cannot reach a row. The excessive grant is
-- recorded for a later privilege-cleanup wave; this migration is RLS, not grant
-- redesign, and removing grants here would be an unreviewed behaviour change.
--
-- ADMIN ACCESS IS NOT INVENTED HERE
-- `p7adm_read` already exists as a canonical policy on Conversation and
-- BillingDocument (migration 20260825090000_d2_p7_w2gate_admin_read) and is left
-- exactly as it is. Note the real consequence: those policies have been INERT in
-- Production because RLS was off, and enabling RLS makes them live — which is what
-- they were written for. The only platform-admin consumer of these five tables reads
-- Conversation and BillingDocument and nothing else, so Customer, Appointment and
-- PaymentRequest deliberately get NO admin policy: zero consumers, zero privilege.
--
-- PREVIEW CONVERGENCE
-- `p4b_tenant` exists only on Preview, only because a human ran it there. It is
-- dropped unconditionally so no environment is left with two overlapping permissive
-- tenant policies (permissive policies OR together, so leaving it would keep the
-- accidental DELETE alive on Preview). The DROP is a harmless no-op anywhere the
-- pilot never ran, including Production.
--
-- Environment-portable: no role is created, no LOGIN, no grant, no ownership change,
-- no BYPASSRLS, no SECURITY DEFINER, no data DML.

-- ============================================================
-- Conversation
-- ============================================================
DROP POLICY IF EXISTS p4b_tenant ON "Conversation";

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7pilot_tenant_read ON "Conversation";
CREATE POLICY p7pilot_tenant_read ON "Conversation" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Conversation";
CREATE POLICY p7pilot_tenant_insert ON "Conversation" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_update ON "Conversation";
CREATE POLICY p7pilot_tenant_update ON "Conversation" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Customer
--
-- Anonymisation during account erasure is an UPDATE, not a delete (issued invoices
-- reference customerId), so the tenant contract needs no DELETE here either.
-- ============================================================
DROP POLICY IF EXISTS p4b_tenant ON "Customer";

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7pilot_tenant_read ON "Customer";
CREATE POLICY p7pilot_tenant_read ON "Customer" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Customer";
CREATE POLICY p7pilot_tenant_insert ON "Customer" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_update ON "Customer";
CREATE POLICY p7pilot_tenant_update ON "Customer" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Appointment
--
-- Cancellation is a status transition (`status` -> CANCELLED) performed by the
-- appointment service as an UPDATE. No runtime path physically deletes an
-- appointment, so no DELETE policy.
-- ============================================================
DROP POLICY IF EXISTS p4b_tenant ON "Appointment";

ALTER TABLE "Appointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7pilot_tenant_read ON "Appointment";
CREATE POLICY p7pilot_tenant_read ON "Appointment" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Appointment";
CREATE POLICY p7pilot_tenant_insert ON "Appointment" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_update ON "Appointment";
CREATE POLICY p7pilot_tenant_update ON "Appointment" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- BillingDocument
--
-- Issued documents are legally immutable and are never physically removed —
-- reversal is a credit/cancellation lifecycle record, not a delete. A DELETE policy
-- here would contradict the billing-compliance non-negotiables.
-- ============================================================
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

-- ============================================================
-- PaymentRequest
--
-- The provider bootstrap resolves an external identity to a stored PaymentRequest
-- BEFORE tenant context exists; that lookup runs on the payment webhook's own
-- boundary and is unchanged here. Everything downstream of the resolved businessId
-- is tenant-owned and covered by these policies. PaymentTransaction already composes
-- against this table through its own W4E-A policy, which carries the tenant predicate
-- inside its EXISTS and therefore never depended on this migration.
-- ============================================================
DROP POLICY IF EXISTS p4b_tenant ON "PaymentRequest";

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
