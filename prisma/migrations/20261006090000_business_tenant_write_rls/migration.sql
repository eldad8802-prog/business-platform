-- ============================================================================
-- Business — tenant-pinned WRITES, unchanged reads (B4)
--
-- Business is the tenant root and carries no RLS by design
-- (20260908180000_d2_user_business_privilege_narrowing): login, session
-- resolution, signup, lifecycle gates (runTenantJob, webhooks, the settlement
-- cron, the intake sweeper) and the public coupon pages read it BEFORE any
-- tenant exists. Its boundary was column privilege only. That left one real gap,
-- proven on PG17 and confirmed in Production (business-runtime-columns-preflight
-- run 36925655282, 35/35): the runtime holds column UPDATE on the lifecycle
-- columns (deletionRequestedAt, deletedAt, archivedAt, archivedByUserId,
-- updatedAt), so a runtime transaction scoped to business A could set business
-- B's lifecycle — a cross-tenant write gated only by application code.
--
-- This migration closes the WRITE without touching any read:
--   * SELECT  — USING (true): every existing read keeps working exactly as today.
--               Column grants still decide WHICH columns each role may read.
--   * UPDATE  — USING / WITH CHECK id = app.current_business_id: a write can only
--               touch the business the transaction names. With no tenant context
--               it touches nothing. The two account-deletion transitions name
--               their own business first (code shipped BEFORE this migration).
--   * INSERT  — TO app_auth only: signup creates the business before a tenant
--               exists. No other role inserts (the runtime holds no INSERT).
--   * DELETE  — no policy at all: nothing deletes a Business; the owner (BYPASSRLS)
--               remains the only path, as today.
-- FORCE is set so the policies also bind roles that own nothing; the migration
-- owner keeps BYPASSRLS. No grant changes, no data changes, no column changes.
--
-- Rollback: DROP the three policies; ALTER TABLE "Business" NO FORCE / DISABLE
-- ROW LEVEL SECURITY. Nothing else to restore.
-- ============================================================================

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Business' AND relrowsecurity) THEN
    RAISE EXCEPTION 'B4: Business already has row-level security — inspect before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = 'Business') THEN
    RAISE EXCEPTION 'B4: Business already has policies — inspect before migrating';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    RAISE EXCEPTION 'B4: role app_auth (signup) is required';
  END IF;
END
$pre$;

ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Business" FORCE ROW LEVEL SECURITY;

CREATE POLICY business_read_unchanged ON "Business" FOR SELECT
  USING (true);

CREATE POLICY business_tenant_write ON "Business" FOR UPDATE
  USING ("id" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("id" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY business_signup_insert ON "Business" FOR INSERT TO app_auth
  WITH CHECK (true);
