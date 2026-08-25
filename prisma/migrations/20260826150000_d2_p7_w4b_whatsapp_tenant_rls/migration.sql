-- D2 / P7-W4B — tenant RLS for the WhatsApp conversation cluster.
--
-- Same contract as Waves 1-3: EXPAND-ONLY, idempotent, role-free. INERT under
-- owner/BYPASSRLS runtimes (production today); enforcing under the Preview
-- least-privilege runtime role.
--
-- SPECIAL (deliberately NOT here): WhatsAppConnection — the provider-bootstrap
-- mapping (phone_number_id -> businessId). Reading it IS the tenant
-- resolution (pre-context, like User/Business/POSApiKey), so it stays
-- app-guarded with tight grants and no tenant RLS. See
-- docs/security-d2-provider-bootstrap-allowlist-v1.md.
--
-- NOT touched: Conversation (pilot policy), BusinessBot + bot children
-- (Wave 2), admin foundation policies.
--
-- No admin policies: no admin-client path reads any W4B table (verified —
-- platform-business-detail reads WhatsAppAttachmentImport on the legacy
-- tenant-client ratchet, which is already documented silent-zero debt).
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- Direct tenancy (businessId column) — 4 tables
-- ============================================================

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "Message";
CREATE POLICY p7w4b_tenant ON "Message"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "BusinessBotSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotSettings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "BusinessBotSettings";
CREATE POLICY p7w4b_tenant ON "BusinessBotSettings"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ReplySuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplySuggestion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "ReplySuggestion";
CREATE POLICY p7w4b_tenant ON "ReplySuggestion"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "WhatsAppAttachmentImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsAppAttachmentImport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "WhatsAppAttachmentImport";
CREATE POLICY p7w4b_tenant ON "WhatsAppAttachmentImport"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy (parent-join via the RLS-protected Message) — 1 table
--
-- The EXISTS subquery runs as the querying role, so for the tenant runtime
-- the parent Message row is itself visible only under the same GUC — the
-- predicate composes with (never bypasses) the parent policy.
-- ============================================================

ALTER TABLE "MessageAnalysis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageAnalysis" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "MessageAnalysis";
CREATE POLICY p7w4b_tenant ON "MessageAnalysis"
  USING (EXISTS (SELECT 1 FROM "Message" p WHERE p."id" = "MessageAnalysis"."messageId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "Message" p WHERE p."id" = "MessageAnalysis"."messageId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));
