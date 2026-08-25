-- D2 / P7 Wave 2 — tenant RLS for the bot-children / content / learning /
-- party / RIA / memory cluster + the Wave-2 additive admin SELECT policy.
--
-- Same contract as the Wave-1 migration: EXPAND-ONLY, idempotent, role-free
-- except the env-neutral NOLOGIN `app_admin` group (created by the W2-GATE
-- migration; policies referencing it are portable). INERT wherever the
-- runtime connects as owner/BYPASSRLS (production today).
--
-- Deliberately NOT here (deferred to the webhook wave with justification):
--   BusinessBot, BusinessBotSettings — read directly by the inbound WhatsApp
--   pipeline (no tenant context yet); their CHILD tables ARE protected below
--   via parent-join (the children's only consumers are authenticated
--   bot-builder routes). VendorLearning — read inside the OCR pipeline.
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- Direct tenancy (businessId column) — 14 tables
-- ============================================================

ALTER TABLE "ContentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "ContentRun";
CREATE POLICY p7w2_tenant ON "ContentRun"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ContentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "ContentEvent";
CREATE POLICY p7w2_tenant ON "ContentEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "LearningEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LearningEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "LearningEvent";
CREATE POLICY p7w2_tenant ON "LearningEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "LearningSignal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LearningSignal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "LearningSignal";
CREATE POLICY p7w2_tenant ON "LearningSignal"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Usage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "Usage";
CREATE POLICY p7w2_tenant ON "Usage"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "FinancialDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialDocument" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "FinancialDocument";
CREATE POLICY p7w2_tenant ON "FinancialDocument"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Party" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Party" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "Party";
CREATE POLICY p7w2_tenant ON "Party"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PartyResolutionClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartyResolutionClaim" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "PartyResolutionClaim";
CREATE POLICY p7w2_tenant ON "PartyResolutionClaim"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RiaCanonicalReferent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RiaCanonicalReferent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "RiaCanonicalReferent";
CREATE POLICY p7w2_tenant ON "RiaCanonicalReferent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RiaPolicyLineage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RiaPolicyLineage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "RiaPolicyLineage";
CREATE POLICY p7w2_tenant ON "RiaPolicyLineage"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "DerivedClaimProjection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DerivedClaimProjection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "DerivedClaimProjection";
CREATE POLICY p7w2_tenant ON "DerivedClaimProjection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "DerivedClaimEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DerivedClaimEvidenceLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "DerivedClaimEvidenceLink";
CREATE POLICY p7w2_tenant ON "DerivedClaimEvidenceLink"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Recommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recommendation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "Recommendation";
CREATE POLICY p7w2_tenant ON "Recommendation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RecommendationOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecommendationOutcome" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "RecommendationOutcome";
CREATE POLICY p7w2_tenant ON "RecommendationOutcome"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy — 7 bot children (parent BusinessBot via botId; the parent
-- itself keeps app-level protection until the webhook wave, and the EXISTS
-- below enforces parent ownership regardless)
-- ============================================================

ALTER TABLE "BusinessBotProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotProfile";
CREATE POLICY p7w2_tenant ON "BusinessBotProfile"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotProfile"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotProfile"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BotGoalSelection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BotGoalSelection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BotGoalSelection";
CREATE POLICY p7w2_tenant ON "BotGoalSelection"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BotGoalSelection"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BotGoalSelection"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BusinessBotSetupDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotSetupDraft" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotSetupDraft";
CREATE POLICY p7w2_tenant ON "BusinessBotSetupDraft"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotSetupDraft"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotSetupDraft"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BusinessBotKnowledge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotKnowledge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotKnowledge";
CREATE POLICY p7w2_tenant ON "BusinessBotKnowledge"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotKnowledge"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotKnowledge"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BusinessBotRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotRecommendation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotRecommendation";
CREATE POLICY p7w2_tenant ON "BusinessBotRecommendation"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotRecommendation"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotRecommendation"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BusinessBotMemoryPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotMemoryPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotMemoryPolicy";
CREATE POLICY p7w2_tenant ON "BusinessBotMemoryPolicy"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotMemoryPolicy"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotMemoryPolicy"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "BusinessBotLearningSuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotLearningSuggestion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessBotLearningSuggestion";
CREATE POLICY p7w2_tenant ON "BusinessBotLearningSuggestion"
  USING (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotLearningSuggestion"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "BusinessBot" p WHERE p."id" = "BusinessBotLearningSuggestion"."botId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- Indirect tenancy — content children (ContentVariant depth-1,
-- ContentRender depth-2 through ContentVariant -> ContentRun; the chain
-- ContentRender.contentVariantId -> ContentVariant.contentRunId ->
-- ContentRun.businessId is schema-verified)
-- ============================================================

ALTER TABLE "ContentVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentVariant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "ContentVariant";
CREATE POLICY p7w2_tenant ON "ContentVariant"
  USING (EXISTS (SELECT 1 FROM "ContentRun" p WHERE p."id" = "ContentVariant"."contentRunId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "ContentRun" p WHERE p."id" = "ContentVariant"."contentRunId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "ContentRender" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentRender" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "ContentRender";
CREATE POLICY p7w2_tenant ON "ContentRender"
  USING (EXISTS (
    SELECT 1 FROM "ContentVariant" v JOIN "ContentRun" r ON r."id" = v."contentRunId"
    WHERE v."id" = "ContentRender"."contentVariantId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "ContentVariant" v JOIN "ContentRun" r ON r."id" = v."contentRunId"
    WHERE v."id" = "ContentRender"."contentVariantId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- Indirect tenancy — memory child
-- ============================================================

ALTER TABLE "DerivedClaimCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DerivedClaimCandidate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "DerivedClaimCandidate";
CREATE POLICY p7w2_tenant ON "DerivedClaimCandidate"
  USING (EXISTS (SELECT 1 FROM "DerivedClaimProjection" p WHERE p."id" = "DerivedClaimCandidate"."projectionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "DerivedClaimProjection" p WHERE p."id" = "DerivedClaimCandidate"."projectionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- Additive admin SELECT (platform-overview reads ContentRun cross-tenant)
-- ============================================================

DROP POLICY IF EXISTS p7adm_read ON "ContentRun";
CREATE POLICY p7adm_read ON "ContentRun"
  FOR SELECT TO app_admin
  USING (true);
