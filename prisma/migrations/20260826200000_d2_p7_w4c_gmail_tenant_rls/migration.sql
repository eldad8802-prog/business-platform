-- D2 / P7-W4C — tenant RLS for the Gmail cluster.
--
-- Same contract as prior waves: EXPAND-ONLY, idempotent, role-free (the
-- app_admin GROUP is env-neutral and exists via the W2-GATE canonical
-- migration). INERT under owner/BYPASSRLS runtimes (production today);
-- enforcing under the Preview least-privilege runtime role.
--
-- EmailConnection is NOT a provider-bootstrap table: the OAuth callback
-- derives the tenant from the VERIFIED signed state (W4A) before any
-- EmailConnection access, and every other reader is Bearer-authenticated —
-- full tenant RLS is safe (re-verified in the W4C audit).
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- Direct tenancy (businessId column) — 2 tables
-- ============================================================

ALTER TABLE "EmailConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4c_tenant ON "EmailConnection";
CREATE POLICY p7w4c_tenant ON "EmailConnection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "EmailAttachmentImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailAttachmentImport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4c_tenant ON "EmailAttachmentImport";
CREATE POLICY p7w4c_tenant ON "EmailAttachmentImport"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy (parent-join via the RLS-protected EmailConnection)
--
-- The EXISTS subquery runs as the querying role, so for the tenant runtime
-- the parent row is itself visible only under the same GUC — the predicate
-- composes with (never bypasses) the parent policy.
-- ============================================================

ALTER TABLE "OAuthToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OAuthToken" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4c_tenant ON "OAuthToken";
CREATE POLICY p7w4c_tenant ON "OAuthToken"
  USING (EXISTS (SELECT 1 FROM "EmailConnection" p WHERE p."id" = "OAuthToken"."connectionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "EmailConnection" p WHERE p."id" = "OAuthToken"."connectionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- Additive admin read policy — REQUIRED consumer: platform-overview runs on
-- the sanctioned admin client (getPrismaAdmin) and counts EmailConnection.
-- Permissive-OR: tenant policy untouched; app_admin gets read-only.
-- (4th p7adm_read policy — after Conversation, BillingDocument, ContentRun.)
-- ============================================================

DROP POLICY IF EXISTS p7adm_read ON "EmailConnection";
CREATE POLICY p7adm_read ON "EmailConnection"
  FOR SELECT TO app_admin USING (true);
