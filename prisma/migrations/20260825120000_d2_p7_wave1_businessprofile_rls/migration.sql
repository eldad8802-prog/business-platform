-- D2 / P7 Wave 1 (extension) — tenant Row-Level Security for BusinessProfile.
--
-- Additive follow-up to 20260824210000_d2_p7_wave1_tenant_rls. BusinessProfile
-- is a direct-tenancy table ("businessId" column), so it takes the IDENTICAL
-- fail-closed predicate and the same p7w1_tenant policy name as the canonical
-- Wave-1 cluster — no new variant.
--
-- Why now: F-25 makes the deals-generate handler derive the business
-- category/subCategory from the authenticated tenant's BusinessProfile (server-
-- owned identity). Under the least-privilege runtime role that read must be
-- tenant-scoped by RLS; the matching GRANT SELECT lives in the per-environment
-- grants artifact (scripts/security/d2-p7-wave1-grants.sql).
--
-- Same properties as the canonical migration:
--   * No role names here (policies apply to every non-BYPASSRLS role).
--   * INERT where the runtime connects as owner / BYPASSRLS (production today:
--     neondb_owner) — RLS never applies to BYPASSRLS.
--   * Idempotent: DROP POLICY IF EXISTS guards CREATE; ENABLE/FORCE are
--     idempotent by nature.
--
-- Fail-closed tenant predicate (identical to the canonical migration):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
-- No GUC / empty GUC -> NULL -> no rows visible, no writes accepted.

ALTER TABLE "BusinessProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "BusinessProfile";
CREATE POLICY p7w1_tenant ON "BusinessProfile"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
