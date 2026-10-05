-- Closed Loop Activation — durable WHY for owner-facing recommendations, and the owner surface switch.
--
-- 1. OutcomeRecommendationEvidence: what Dubiz saw, at the moment it issued ONE recommendation version, in a
--    structured, bounded form (ids, dates, day counts, codes, and — for an overdue installment — the remaining
--    amount the owner already sees in their own payables). So "why did Dubiz recommend this to me then?" is
--    answered from what was captured, never recomputed from today's state. No names, no document text, no free
--    text, no raw rows.
--      - one row per recommendation version (recommendation ids are already one per version)
--      - APPEND-ONLY: the M9 guard refuses UPDATE and DELETE for every role; a cascade from the business or the
--        recommendation (trigger depth > 1) is the only deletion path, exactly as for the other M9 history
--      - tenant: composite (businessId, recommendationId) FK; ENABLE + FORCE RLS; SELECT and INSERT policies on
--        the app.current_business_id GUC; no UPDATE / DELETE policy; runtime holds SELECT, INSERT only
-- 2. Feature `owner_recommendations` — DEFAULT OFF, globally off. A business sees recommendations only when the
--    platform admin explicitly allows it through the existing audited feature-access path.
--
-- No backfill: the six recommendations already in Production get no evidence row from this migration.
-- Idempotent where Prisma allows (feature rows ON CONFLICT DO NOTHING).

CREATE TABLE "OutcomeRecommendationEvidence" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "evidenceVersion" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "factFingerprint" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeRecommendationEvidence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutcomeRecommendationEvidence" ADD CONSTRAINT "OutcomeRecommendationEvidence_kind_chk"
  CHECK ("kind" IN ('OVERDUE_INSTALLMENT', 'REVIEW_BACKLOG'));
ALTER TABLE "OutcomeRecommendationEvidence" ADD CONSTRAINT "OutcomeRecommendationEvidence_facts_object_chk"
  CHECK (jsonb_typeof("facts") = 'object' AND jsonb_typeof("evidenceRefs") = 'array');

CREATE UNIQUE INDEX "OutcomeRecommendationEvidence_businessId_id_key" ON "OutcomeRecommendationEvidence"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeRecommendationEvidence_businessId_recommendationId_key"
  ON "OutcomeRecommendationEvidence"("businessId", "recommendationId");

ALTER TABLE "OutcomeRecommendationEvidence" ADD CONSTRAINT "OutcomeRecommendationEvidence_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeRecommendationEvidence" ADD CONSTRAINT "OutcomeRecommendationEvidence_recommendation_fkey"
  FOREIGN KEY ("businessId", "recommendationId") REFERENCES "OutcomeRecommendation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only, with the same guard as the rest of the outcome history.
CREATE TRIGGER "OutcomeRecommendationEvidence_append_only" BEFORE UPDATE OR DELETE ON "OutcomeRecommendationEvidence"
  FOR EACH ROW EXECUTE FUNCTION public.m9_append_only_guard();

-- Tenant isolation: per-command policies, fail-closed without the GUC. No UPDATE or DELETE policy.
ALTER TABLE "OutcomeRecommendationEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeRecommendationEvidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_recommendation_evidence_tenant_read ON "OutcomeRecommendationEvidence" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_recommendation_evidence_tenant_insert ON "OutcomeRecommendationEvidence" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "OutcomeRecommendationEvidence" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeRecommendationEvidence_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "OutcomeRecommendationEvidence" FROM app_runtime;
  END IF;
END
$do$;

-- ── Feature: owner_recommendations (default off) ─────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('owner_recommendations', 'המלצות Dubiz', 'intelligence', 'הצגת המלצות Dubiz לבעל העסק וקבלת החלטתו — כבויה כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('owner_recommendations', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
