-- D2 / P7-W4E-B-2 — tenant RLS for the Billing + Billing Authority cluster.
--
-- Ordering note: this migration deliberately lands AFTER the W4E-B-1 trust
-- repair. Enabling FORCE RLS on BillingAuthorityConnection while the OAuth
-- callback still took its tenant from an unsigned cookie would have enforced
-- the WRONG tenant precisely — the policy would faithfully scope writes to
-- whatever business the caller's cookie named. B-1 closed that first.
--
-- Same contract as prior waves: EXPAND-ONLY, idempotent, role-free. INERT under
-- owner/BYPASSRLS runtimes (production today); enforcing under the Preview
-- least-privilege runtime role.
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- 1. Direct tenancy (businessId column) — 6 tables
-- ============================================================

ALTER TABLE "BillingAuthorityConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthorityConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuthorityConnection";
CREATE POLICY p7w4eb2_tenant ON "BillingAuthorityConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingAuthoritySubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuthoritySubmission" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuthoritySubmission";
CREATE POLICY p7w4eb2_tenant ON "BillingAuthoritySubmission"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingPaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingPaymentAllocation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingPaymentAllocation";
CREATE POLICY p7w4eb2_tenant ON "BillingPaymentAllocation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Legal document numbering. The allocation is an upsert on
-- (businessId, documentType) with nextNumber: { increment: 1 }, running inside
-- the issuance transaction. RLS does not change that: the conflicting row
-- always belongs to the same business as the GUC, so it is visible to the
-- policy and ON CONFLICT still resolves to an UPDATE rather than raising; the
-- increment keeps its row lock, so concurrent issuance for one business still
-- serialises and still yields unique consecutive numbers. What the policy adds
-- is that no other tenant's sequence is reachable at all.
ALTER TABLE "BillingDocumentNumberSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentNumberSequence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingDocumentNumberSequence";
CREATE POLICY p7w4eb2_tenant ON "BillingDocumentNumberSequence"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BillingAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingAuditEvent";
CREATE POLICY p7w4eb2_tenant ON "BillingAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- BusinessBot: every access site is either a tenant transaction or the
-- ctx-aware dbStep, and the one pipeline consumer (loadBotComposeContext) takes
-- an explicit businessId and runs AFTER WhatsApp tenant resolution under
-- runTenantJob. There is no legitimate pre-context read, so it is protectable.
-- BusinessBotSettings is already covered by W4B — deliberately not touched.
ALTER TABLE "BusinessBot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BusinessBot";
CREATE POLICY p7w4eb2_tenant ON "BusinessBot"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- 2. Indirect tenancy (parent-join through BillingDocument) — 2 tables
--
-- BillingDocument is already FORCE-RLS'd by the P4-B pilot, so the EXISTS
-- subquery — which runs as the querying role — can only see a parent row under
-- the same GUC. These predicates COMPOSE with the pilot policy; they never
-- bypass it, and no policy is added to BillingDocument itself.
-- ============================================================

ALTER TABLE "BillingDocumentLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingDocumentLine";
CREATE POLICY p7w4eb2_tenant ON "BillingDocumentLine"
  USING (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingDocumentLine"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingDocumentLine"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BillingReceiptPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingReceiptPayment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4eb2_tenant ON "BillingReceiptPayment";
CREATE POLICY p7w4eb2_tenant ON "BillingReceiptPayment"
  USING (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingReceiptPayment"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BillingDocument" p WHERE p."id" = "BillingReceiptPayment"."billingDocumentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- 3. No admin read policies in W4E-B-2.
--
-- Verified firsthand: no admin-client consumer reads any of these tables.
-- platform-admin reads BillingDocument only (already granted + p7adm_read in
-- W2, and on the documented CI-4 legacy ratchet). Granting app_admin read of
-- authority token metadata or a legal numbering sequence with no consumer
-- would be pure attack surface, so none is created.
--
-- BusinessFeatureAccess is deliberately ABSENT: its only writer is the
-- platform-admin route, which mutates another business's rows by design, so
-- tenant RLS there would require global admin writes — outside the ratified
-- read-only app_admin doctrine. Deferred to a dedicated privileged-write wave.
-- ============================================================
