-- Knowledge-derive authority — enrollment + a run ledger for /api/knowledge/derive.
--
-- WHY
-- The derive route accepted the general CRON_SECRET (shared with settlement recovery, reconciliation
-- and the intake sweep) plus a caller-chosen ?businessId=, and nothing else: no enrollment, no
-- lifecycle gate, no attribution, no rate bound. A holder of that one secret could derive — and, with
-- the Brain in shadow, send minimized knowledge to the model provider — for ANY business, including one
-- in account-deletion quarantine.
--
-- WHAT THIS MIGRATION ADDS (the code that uses it ships after it is applied)
--   1. Feature `knowledge_derivation` — DEFAULT OFF, globally off. A business is derivable only when a
--      platform admin enables it for that business through the existing, audited feature-access path.
--      The request's businessId selects a target; it never grants authority. emergencyDisabled stops
--      every derivation at once.
--   2. KnowledgeDerivationRun — the per-business run ledger that makes derivation rate- and
--      concurrency-bounded and attributable: at most one RUNNING run per business (partial unique
--      index), a cooldown between runs, and a separate, longer cooldown between Brain (provider) runs.
--      Counts, statuses, codes and versions only.
--
-- The security audit trail itself is the existing append-only SecurityEvent store (SEC-F); nothing new
-- is invented for it.
--
-- EXPAND-ONLY: one feature definition + policy row, one table. No existing table, column or row changes.

-- ── 1. Feature: knowledge_derivation (default off) ──────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('knowledge_derivation', 'גזירת ידע עסקי', 'intelligence', 'הרשאת הפעלת גזירת ידע (למידה) עבור העסק — כבויה כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('knowledge_derivation', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;

-- ── 2. KnowledgeDerivationRun ───────────────────────────────────────────────────

CREATE TABLE "KnowledgeDerivationRun" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "callerClass" TEXT NOT NULL,
    "callerRef" TEXT,
    "brainRequested" BOOLEAN NOT NULL DEFAULT false,
    "brainAllowed" BOOLEAN NOT NULL DEFAULT false,
    "brainInvoked" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "failureStage" TEXT,
    "counts" JSONB,
    "versions" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeDerivationRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_status_chk"
  CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED'));
ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_finished_chk"
  CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL));
ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_caller_chk"
  CHECK ("callerClass" ~ '^[a-z][a-z0-9_]{0,63}$' AND ("callerRef" IS NULL OR "callerRef" ~ '^[0-9]{1,20}$'));
ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_stage_chk"
  CHECK ("failureStage" IS NULL OR "failureStage" ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_payload_chk"
  CHECK (("counts" IS NULL OR (jsonb_typeof("counts") = 'object' AND octet_length("counts"::text) <= 4096))
     AND ("versions" IS NULL OR (jsonb_typeof("versions") = 'object' AND octet_length("versions"::text) <= 2048)));
ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_brain_chk"
  CHECK ((NOT "brainInvoked" OR "brainAllowed") AND (NOT "brainAllowed" OR "brainRequested"));

CREATE UNIQUE INDEX "KnowledgeDerivationRun_runId_key" ON "KnowledgeDerivationRun"("runId");
-- At most ONE running derivation per business: concurrency is a database fact.
CREATE UNIQUE INDEX "KnowledgeDerivationRun_one_running_key"
  ON "KnowledgeDerivationRun"("businessId") WHERE "status" = 'RUNNING';
CREATE INDEX "KnowledgeDerivationRun_businessId_startedAt_idx" ON "KnowledgeDerivationRun"("businessId", "startedAt");

ALTER TABLE "KnowledgeDerivationRun" ADD CONSTRAINT "KnowledgeDerivationRun_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A run moves once, from RUNNING to a terminal state; its identity, caller and start never change.
CREATE OR REPLACE FUNCTION public.kdr_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ911', MESSAGE = 'KDR_APPEND_ONLY: a derivation run cannot be deleted';
  END IF;
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ912', MESSAGE = 'KDR_IMMUTABLE: a finished derivation run cannot change';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','finishedAt','failureStage','counts','versions','brainInvoked'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','finishedAt','failureStage','counts','versions','brainInvoked']) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ912', MESSAGE = 'KDR_IMMUTABLE: only the outcome of a run may be recorded';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.kdr_run_guard() FROM PUBLIC;
CREATE TRIGGER "KnowledgeDerivationRun_guard" BEFORE UPDATE OR DELETE ON "KnowledgeDerivationRun"
  FOR EACH ROW EXECUTE FUNCTION public.kdr_run_guard();

ALTER TABLE "KnowledgeDerivationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeDerivationRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_derivation_run_tenant_select ON "KnowledgeDerivationRun" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY knowledge_derivation_run_tenant_insert ON "KnowledgeDerivationRun" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY knowledge_derivation_run_tenant_update ON "KnowledgeDerivationRun" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "KnowledgeDerivationRun" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "KnowledgeDerivationRun_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "KnowledgeDerivationRun" FROM app_runtime;
  END IF;
END
$do$;
