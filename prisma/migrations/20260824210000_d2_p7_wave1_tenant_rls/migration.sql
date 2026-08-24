-- D2 / P7 Wave 1 — tenant Row-Level Security for the low-risk tenant-only cluster.
--
-- EXPAND-ONLY and environment-portable:
--   * No role names appear here. Policies apply to every non-BYPASSRLS role;
--     grants (which ARE role-specific) live in a separate per-environment
--     artifact (scripts/security/d2-p7-wave1-grants.sql).
--   * On a database whose runtime connects as the owner / a BYPASSRLS role
--     (production today: neondb_owner), this migration is INERT — RLS never
--     applies to BYPASSRLS. Enforcement begins only where a least-privilege
--     runtime role is in use (Preview: app_runtime_preview_p4b).
--   * Idempotent: re-running it (manual apply on Preview + `migrate deploy`
--     later) is safe — CREATE POLICY is guarded by DROP POLICY IF EXISTS and
--     ENABLE/FORCE are idempotent by nature.
--
-- Fail-closed tenant predicate (same shape as the proven P4-B pilot):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
-- No GUC / empty GUC -> NULL -> no rows visible, no writes accepted.

-- ============================================================
-- Direct tenancy (businessId column) — 11 tables
-- ============================================================

-- BusinessObligation
ALTER TABLE "BusinessObligation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessObligation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "BusinessObligation";
CREATE POLICY p7w1_tenant ON "BusinessObligation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- BusinessObligationOrientation (businessId IS the primary key)
ALTER TABLE "BusinessObligationOrientation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessObligationOrientation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "BusinessObligationOrientation";
CREATE POLICY p7w1_tenant ON "BusinessObligationOrientation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- CrmNote
ALTER TABLE "CrmNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrmNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "CrmNote";
CREATE POLICY p7w1_tenant ON "CrmNote"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- CrmAttachment
ALTER TABLE "CrmAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrmAttachment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "CrmAttachment";
CREATE POLICY p7w1_tenant ON "CrmAttachment"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- PricingProfile
ALTER TABLE "PricingProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "PricingProfile";
CREATE POLICY p7w1_tenant ON "PricingProfile"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- PricingCalculation
ALTER TABLE "PricingCalculation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingCalculation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "PricingCalculation";
CREATE POLICY p7w1_tenant ON "PricingCalculation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Task (zero live runtime consumers — protected and deliberately ungranted)
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "Task";
CREATE POLICY p7w1_tenant ON "Task"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- CollaborationDeal
ALTER TABLE "CollaborationDeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollaborationDeal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "CollaborationDeal";
CREATE POLICY p7w1_tenant ON "CollaborationDeal"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Lead (sole runtime consumer is the account-deletion erasure, deferred to a
-- later wave — protected now, granted then)
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "Lead";
CREATE POLICY p7w1_tenant ON "Lead"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Deal (zero live runtime consumers — protected and deliberately ungranted)
ALTER TABLE "Deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "Deal";
CREATE POLICY p7w1_tenant ON "Deal"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- BusinessService (parent of the two indirect tables below)
ALTER TABLE "BusinessService" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessService" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "BusinessService";
CREATE POLICY p7w1_tenant ON "BusinessService"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy (parent-join through BusinessService) — 2 tables
-- The EXISTS subquery is itself filtered by BusinessService's own RLS for
-- non-BYPASSRLS roles, so parent invisibility implies child invisibility —
-- the two policies reinforce in the same direction.
-- ============================================================

-- ServiceCostProfile -> BusinessService(businessServiceId)
ALTER TABLE "ServiceCostProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCostProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "ServiceCostProfile";
CREATE POLICY p7w1_tenant ON "ServiceCostProfile"
  USING (EXISTS (
    SELECT 1 FROM "BusinessService" p
    WHERE p."id" = "ServiceCostProfile"."businessServiceId"
      AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "BusinessService" p
    WHERE p."id" = "ServiceCostProfile"."businessServiceId"
      AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- PricingRecommendation -> BusinessService(businessServiceId)
ALTER TABLE "PricingRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricingRecommendation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "PricingRecommendation";
CREATE POLICY p7w1_tenant ON "PricingRecommendation"
  USING (EXISTS (
    SELECT 1 FROM "BusinessService" p
    WHERE p."id" = "PricingRecommendation"."businessServiceId"
      AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "BusinessService" p
    WHERE p."id" = "PricingRecommendation"."businessServiceId"
      AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));
