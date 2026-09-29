-- M9 · Outcome learning loop — Recommendation → Owner Decision → Action → Outcome → Assessment.
--
-- WHY FIVE TABLES AND NOT ONE "FEEDBACK" TABLE
-- A recommendation is not a decision, a decision is not an action, an action is not an outcome, and
-- an outcome that followed an action is not an effect OF it. Each of those is a different claim with
-- a different author (the system, the owner, the domain ledger, the calendar), so each gets its own
-- record and its own mutability:
--
--   OutcomeRecommendation  system-issued, VERSIONED. Content immutable; only its lifecycle moves
--                          (ACTIVE → SUPERSEDED | RESOLVED | EXPIRED), and only forward.
--   OutcomeDecision        what the OWNER said. APPEND-ONLY. A change of mind is a new row that
--                          names the one it supersedes; history is never rewritten.
--   OutcomeActionEvent     what the DOMAIN LEDGER shows actually happened to a target (a document
--                          reviewed, a payment recorded) — and, separately, its reversal. APPEND-ONLY.
--   OutcomeObservation     what was OBSERVED afterwards (backlog size, settlement, lateness).
--                          APPEND-ONLY; a reversal is a new observation that names the one it reverses.
--   OutcomeAssessment      the deterministic reading of the above. APPEND + SUPERSEDE (the M6 model):
--                          unchanged inputs confirm the live row, changed inputs supersede it.
--
-- CAUSALITY IS NOT STORABLE. `OutcomeAssessment.attribution` is CHECK-constrained to the vocabulary
-- Dubiz can actually support: NOT_ASSESSABLE, NO_OUTCOME_OBSERVED, OBSERVED_SEQUENCE. There is no
-- comparison design in the product that could establish a contribution or a cause, so no value that
-- asserts one exists — not in the code, and not in the database.
--
-- TENANCY. Every table carries businessId with an FK to Business, and every child reaches its
-- recommendation through a COMPOSITE key (businessId, recommendationId) → (businessId, id): a row of
-- business A cannot reference a recommendation of business B even with a forged id, whatever RLS does.
--
-- EXPAND-ONLY. Two enums, five tables, their indexes, keys, guards, RLS, policies and grants. No
-- existing table, column, row or policy changes.

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "OutcomeRecommendationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'RESOLVED', 'EXPIRED');
CREATE TYPE "OutcomeDecisionKind" AS ENUM ('ACCEPT', 'REJECT', 'MODIFY', 'NOT_NOW');

-- ── OutcomeRecommendation ────────────────────────────────────────────────────

CREATE TABLE "OutcomeRecommendation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "targets" JSONB NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "supportingSlots" JSONB NOT NULL,
    "severity" TEXT,
    "evidenceFingerprint" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceFindingKey" TEXT,
    "brainContractVersion" TEXT,
    "brainPromptVersion" TEXT,
    "brainContextVersion" TEXT,
    "brainModel" TEXT,
    "snapshotFingerprint" TEXT NOT NULL,
    "contextFingerprint" TEXT,
    "generatorVersion" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "outcomeWindowEnd" TIMESTAMP(3) NOT NULL,
    "status" "OutcomeRecommendationStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "supersededById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeRecommendation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutcomeRecommendation" ADD CONSTRAINT "OutcomeRecommendation_version_chk" CHECK ("version" >= 1);
ALTER TABLE "OutcomeRecommendation" ADD CONSTRAINT "OutcomeRecommendation_source_chk" CHECK (
  ("sourceKind" = 'KNOWLEDGE_RULE' AND "sourceFindingKey" IS NULL)
  OR ("sourceKind" = 'BRAIN_FINDING' AND "sourceFindingKey" IS NOT NULL AND "brainContractVersion" IS NOT NULL));
ALTER TABLE "OutcomeRecommendation" ADD CONSTRAINT "OutcomeRecommendation_closed_chk" CHECK (("status" = 'ACTIVE') = ("closedAt" IS NULL));

CREATE UNIQUE INDEX "OutcomeRecommendation_businessId_id_key" ON "OutcomeRecommendation"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeRecommendation_businessId_recommendationKey_version_key"
  ON "OutcomeRecommendation"("businessId", "recommendationKey", "version");
-- At most ONE live version per recommendation identity: dedupe is a database fact, not a hope.
CREATE UNIQUE INDEX "OutcomeRecommendation_one_active_key"
  ON "OutcomeRecommendation"("businessId", "recommendationKey") WHERE "status" = 'ACTIVE';
CREATE INDEX "OutcomeRecommendation_businessId_status_idx" ON "OutcomeRecommendation"("businessId", "status");
CREATE INDEX "OutcomeRecommendation_businessId_issuedAt_idx" ON "OutcomeRecommendation"("businessId", "issuedAt");

ALTER TABLE "OutcomeRecommendation" ADD CONSTRAINT "OutcomeRecommendation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── OutcomeDecision ──────────────────────────────────────────────────────────

CREATE TABLE "OutcomeDecision" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "recommendationVersion" INTEGER NOT NULL,
    "decision" "OutcomeDecisionKind" NOT NULL,
    "modification" JSONB,
    "reasonCode" TEXT,
    "deferUntil" TIMESTAMP(3),
    "actorUserId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "supersedesDecisionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeDecision_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutcomeDecision" ADD CONSTRAINT "OutcomeDecision_modify_chk" CHECK (("decision" = 'MODIFY') = ("modification" IS NOT NULL));
ALTER TABLE "OutcomeDecision" ADD CONSTRAINT "OutcomeDecision_defer_chk" CHECK ("deferUntil" IS NULL OR "decision" = 'NOT_NOW');

CREATE UNIQUE INDEX "OutcomeDecision_businessId_id_key" ON "OutcomeDecision"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeDecision_businessId_idempotencyKey_key" ON "OutcomeDecision"("businessId", "idempotencyKey");
CREATE INDEX "OutcomeDecision_businessId_recommendationId_idx" ON "OutcomeDecision"("businessId", "recommendationId");

ALTER TABLE "OutcomeDecision" ADD CONSTRAINT "OutcomeDecision_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeDecision" ADD CONSTRAINT "OutcomeDecision_recommendation_fkey"
  FOREIGN KEY ("businessId", "recommendationId") REFERENCES "OutcomeRecommendation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeDecision" ADD CONSTRAINT "OutcomeDecision_supersedes_fkey"
  FOREIGN KEY ("businessId", "supersedesDecisionId") REFERENCES "OutcomeDecision"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── OutcomeActionEvent ───────────────────────────────────────────────────────

CREATE TABLE "OutcomeActionEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "decisionId" INTEGER,
    "actionKind" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "domainStore" TEXT NOT NULL,
    "domainRecordId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeActionEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutcomeActionEvent" ADD CONSTRAINT "OutcomeActionEvent_event_chk" CHECK ("eventType" IN ('PERFORMED', 'REVERSED', 'WITHDRAWN'));

CREATE UNIQUE INDEX "OutcomeActionEvent_businessId_id_key" ON "OutcomeActionEvent"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeActionEvent_businessId_idempotencyKey_key" ON "OutcomeActionEvent"("businessId", "idempotencyKey");
CREATE INDEX "OutcomeActionEvent_businessId_recommendationId_idx" ON "OutcomeActionEvent"("businessId", "recommendationId");

ALTER TABLE "OutcomeActionEvent" ADD CONSTRAINT "OutcomeActionEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeActionEvent" ADD CONSTRAINT "OutcomeActionEvent_recommendation_fkey"
  FOREIGN KEY ("businessId", "recommendationId") REFERENCES "OutcomeRecommendation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeActionEvent" ADD CONSTRAINT "OutcomeActionEvent_decision_fkey"
  FOREIGN KEY ("businessId", "decisionId") REFERENCES "OutcomeDecision"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── OutcomeObservation ───────────────────────────────────────────────────────

CREATE TABLE "OutcomeObservation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "actionEventId" INTEGER,
    "kind" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" INTEGER,
    "valueInt" INTEGER,
    "unit" TEXT,
    "evidenceStore" TEXT NOT NULL,
    "evidenceIds" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "reversesObservationId" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeObservation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_unit_chk" CHECK ("unit" IS NULL OR "unit" IN ('days', 'count'));

CREATE UNIQUE INDEX "OutcomeObservation_businessId_id_key" ON "OutcomeObservation"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeObservation_businessId_idempotencyKey_key" ON "OutcomeObservation"("businessId", "idempotencyKey");
CREATE INDEX "OutcomeObservation_businessId_recommendationId_idx" ON "OutcomeObservation"("businessId", "recommendationId");

ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_recommendation_fkey"
  FOREIGN KEY ("businessId", "recommendationId") REFERENCES "OutcomeRecommendation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_action_fkey"
  FOREIGN KEY ("businessId", "actionEventId") REFERENCES "OutcomeActionEvent"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_reverses_fkey"
  FOREIGN KEY ("businessId", "reversesObservationId") REFERENCES "OutcomeObservation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── OutcomeAssessment ────────────────────────────────────────────────────────

CREATE TABLE "OutcomeAssessment" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "assessorVersion" TEXT NOT NULL,
    "decisionState" TEXT NOT NULL,
    "actionState" TEXT NOT NULL,
    "outcomeState" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "uncertainty" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "detail" JSONB NOT NULL,
    "semanticHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assessedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeAssessment_pkey" PRIMARY KEY ("id")
);

-- The attribution vocabulary IS the causal-safety rule. Nothing that asserts a cause or a
-- contribution can be stored, because no design in the product could establish one.
ALTER TABLE "OutcomeAssessment" ADD CONSTRAINT "OutcomeAssessment_attribution_chk" CHECK ("attribution" IN ('NOT_ASSESSABLE', 'NO_OUTCOME_OBSERVED', 'OBSERVED_SEQUENCE'));
ALTER TABLE "OutcomeAssessment" ADD CONSTRAINT "OutcomeAssessment_status_chk" CHECK ("status" IN ('ACTIVE', 'SUPERSEDED'));
ALTER TABLE "OutcomeAssessment" ADD CONSTRAINT "OutcomeAssessment_superseded_chk" CHECK (("status" = 'SUPERSEDED') = ("supersededAt" IS NOT NULL));

CREATE UNIQUE INDEX "OutcomeAssessment_businessId_id_key" ON "OutcomeAssessment"("businessId", "id");
CREATE UNIQUE INDEX "OutcomeAssessment_one_active_key"
  ON "OutcomeAssessment"("businessId", "recommendationId") WHERE "status" = 'ACTIVE';
CREATE INDEX "OutcomeAssessment_businessId_status_idx" ON "OutcomeAssessment"("businessId", "status");

ALTER TABLE "OutcomeAssessment" ADD CONSTRAINT "OutcomeAssessment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutcomeAssessment" ADD CONSTRAINT "OutcomeAssessment_recommendation_fkey"
  FOREIGN KEY ("businessId", "recommendationId") REFERENCES "OutcomeRecommendation"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── History guards (every role, table owner included) ─────────────────────────
--
-- Direct UPDATE/DELETE on the append-only tables is refused. The only DELETE that passes is one
-- issued BY a foreign-key cascade (pg_trigger_depth() > 1): removing a whole business in a test
-- database, which is not a rewrite of any history. Account erasure never deletes a Business.

CREATE OR REPLACE FUNCTION public.m9_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZ901',
    MESSAGE = format('M9_APPEND_ONLY: %s on %I is refused; outcome history is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;

-- A recommendation's CONTENT never changes; only its lifecycle moves, and only away from ACTIVE.
CREATE OR REPLACE FUNCTION public.m9_recommendation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ901', MESSAGE = 'M9_APPEND_ONLY: DELETE on OutcomeRecommendation is refused';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','closedAt','closedReason','supersededById'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','closedAt','closedReason','supersededById']) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ902', MESSAGE = 'M9_IMMUTABLE: a recommendation''s content cannot change; issue a new version';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    -- The single permitted late write: a SUPERSEDED version is linked, once, to the version that
    -- replaced it (the successor can only be inserted after the old version has left ACTIVE).
    IF OLD."status" = 'SUPERSEDED' AND OLD."supersededById" IS NULL AND NEW."supersededById" IS NOT NULL
       AND (to_jsonb(NEW) - 'supersededById') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'supersededById') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ902', MESSAGE = 'M9_IMMUTABLE: a closed recommendation cannot change';
  END IF;
  RETURN NEW;
END
$fn$;

-- An assessment's CONTENT never changes; a live row may only be re-confirmed or superseded.
CREATE OR REPLACE FUNCTION public.m9_assessment_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ901', MESSAGE = 'M9_APPEND_ONLY: DELETE on OutcomeAssessment is refused';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','confirmedAt','supersededAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','confirmedAt','supersededAt']) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ902', MESSAGE = 'M9_IMMUTABLE: an assessment''s content cannot change; supersede it';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ902', MESSAGE = 'M9_IMMUTABLE: a superseded assessment cannot change';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.m9_append_only_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m9_recommendation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.m9_assessment_guard() FROM PUBLIC;

CREATE TRIGGER "OutcomeRecommendation_guard" BEFORE UPDATE OR DELETE ON "OutcomeRecommendation"
  FOR EACH ROW EXECUTE FUNCTION public.m9_recommendation_guard();
CREATE TRIGGER "OutcomeDecision_append_only" BEFORE UPDATE OR DELETE ON "OutcomeDecision"
  FOR EACH ROW EXECUTE FUNCTION public.m9_append_only_guard();
CREATE TRIGGER "OutcomeActionEvent_append_only" BEFORE UPDATE OR DELETE ON "OutcomeActionEvent"
  FOR EACH ROW EXECUTE FUNCTION public.m9_append_only_guard();
CREATE TRIGGER "OutcomeObservation_append_only" BEFORE UPDATE OR DELETE ON "OutcomeObservation"
  FOR EACH ROW EXECUTE FUNCTION public.m9_append_only_guard();
CREATE TRIGGER "OutcomeAssessment_guard" BEFORE UPDATE OR DELETE ON "OutcomeAssessment"
  FOR EACH ROW EXECUTE FUNCTION public.m9_assessment_guard();

-- ── Tenant isolation ─────────────────────────────────────────────────────────
--
-- Per-command policies (R2): SELECT and INSERT everywhere; UPDATE only where a lifecycle legitimately
-- moves (recommendation status, assessment confirmation/supersession). No DELETE policy anywhere.
-- Fail-closed: with no GUC, NULLIF yields NULL and no row qualifies.

ALTER TABLE "OutcomeRecommendation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeRecommendation" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_recommendation_tenant_read ON "OutcomeRecommendation" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_recommendation_tenant_insert ON "OutcomeRecommendation" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_recommendation_tenant_update ON "OutcomeRecommendation" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OutcomeDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_decision_tenant_read ON "OutcomeDecision" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_decision_tenant_insert ON "OutcomeDecision" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OutcomeActionEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeActionEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_action_event_tenant_read ON "OutcomeActionEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_action_event_tenant_insert ON "OutcomeActionEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OutcomeObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_observation_tenant_read ON "OutcomeObservation" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_observation_tenant_insert ON "OutcomeObservation" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OutcomeAssessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeAssessment" FORCE ROW LEVEL SECURITY;
CREATE POLICY outcome_assessment_tenant_read ON "OutcomeAssessment" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_assessment_tenant_insert ON "OutcomeAssessment" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY outcome_assessment_tenant_update ON "OutcomeAssessment" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Named explicitly; Production's ALTER DEFAULT PRIVILEGES would otherwise hand app_runtime DELETE on
-- every one of these. Append-only tables get SELECT + INSERT and nothing else. Guarded on the role
-- existing, so this is a no-op on a database without app_runtime.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "OutcomeRecommendation" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeRecommendation_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "OutcomeRecommendation" FROM app_runtime;

    GRANT SELECT, INSERT ON "OutcomeDecision" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeDecision_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "OutcomeDecision" FROM app_runtime;

    GRANT SELECT, INSERT ON "OutcomeActionEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeActionEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "OutcomeActionEvent" FROM app_runtime;

    GRANT SELECT, INSERT ON "OutcomeObservation" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeObservation_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "OutcomeObservation" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "OutcomeAssessment" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OutcomeAssessment_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "OutcomeAssessment" FROM app_runtime;
  END IF;
END
$do$;
