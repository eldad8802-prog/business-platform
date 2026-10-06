-- P3-E · Landing persistence, owner approval, versioning, rollback (migration only)
--
-- WHAT THIS ADDS
--   1. "LandingPage": exactly ONE per business. It holds no copy at all — only the two lifecycle
--      pointers (current draft, current approved) and the version counter.
--   2. "LandingPageVersion": an immutable snapshot of ONE validated P3-C blueprint, saved or approved by
--      the owner. A row holds:
--        * the validated blueprint exactly as P3-C produced it (a JSON object with a CLOSED top-level key
--          set, so a raw prompt, a raw model response, the private composer context, trust evidence or
--          demand data cannot be stored beside it), bound by CHECKs to the row's own strategy id / type /
--          blueprint version / business;
--        * every engine version it was produced and rendered under (strategy engine, composer, prompt,
--          composer context, blueprint, renderer) and a sha256 fingerprint of the snapshot;
--        * the owner act behind it: who saved it, and — for an approved version — when and by whom it was
--          approved. Authority is OWNER_SAVED or OWNER_APPROVED; a machine proposal is never stored;
--        * lineage: supersedesVersionId (the version current in the same lane when this one was created),
--          supersededByVersionId (the version that replaced it), rollbackSourceVersionId (a rollback copies
--          an older snapshot into a NEW version — nothing old is reactivated);
--        * a durable idempotency key (unique per business).
--      Status vocabulary (closed): DRAFT, APPROVED, SUPERSEDED, RETIRED.
--      Lifecycle (database-enforced, every role): DRAFT → APPROVED | SUPERSEDED | RETIRED;
--      APPROVED → SUPERSEDED; SUPERSEDED and RETIRED are frozen. The snapshot and every content column
--      never change after insert; a change is a new version. No row is ever deleted except by a
--      cascade from its business.
--   3. Pointer integrity, enforced by the database at commit:
--        * pointers are composite (businessId, id) foreign keys — a page can never point at another
--          tenant's version;
--        * at most one DRAFT and one APPROVED version per page (partial unique indexes), and the page's
--          pointers name exactly those (deferred constraint triggers): a current-approved pointer exists
--          iff an APPROVED version exists, and it points at that one;
--        * version numbers are unique per page and never exceed the page's monotonic counter, which the
--          application advances under the page row lock (never max + 1).
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   - no publication, slug, domain or public read path: APPROVED is the owner's choice, not "published";
--   - no copy of any asset: the snapshot references assets by opaque ref ("asset:12"), never a key or URL;
--   - no DELETE privilege, no DELETE policy, no hard delete of a version (history is kept);
--   - no audit table: owner acts are on the rows themselves (createdBy / approvedBy / retiredBy + times),
--     and the application mirrors them as sensor events (LearningEvent) with codes and ids only;
--   - no backfill. Existing businesses start with no landing page.
--
-- Additive only: two enums, two tables, three functions, triggers, policies and grants.

CREATE TYPE "LandingVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'RETIRED');

CREATE TYPE "LandingVersionAuthority" AS ENUM ('OWNER_SAVED', 'OWNER_APPROVED');

-- ── 1. LandingPage ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "LandingPage" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "currentDraftVersionId" INTEGER,
  "currentApprovedVersionId" INTEGER,
  "lastVersionNumber" INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LandingPage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LandingPage_last_version_number" CHECK ("lastVersionNumber" >= 0),
  CONSTRAINT "LandingPage_created_by" CHECK ("createdByUserId" > 0),
  CONSTRAINT "LandingPage_distinct_pointers" CHECK (
    "currentDraftVersionId" IS NULL OR "currentApprovedVersionId" IS NULL
    OR "currentDraftVersionId" <> "currentApprovedVersionId"
  )
);

-- One landing page per business.
CREATE UNIQUE INDEX "LandingPage_businessId_key" ON "LandingPage"("businessId");
CREATE UNIQUE INDEX "LandingPage_businessId_id_key" ON "LandingPage"("businessId", "id");

ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. LandingPageVersion ────────────────────────────────────────────────────────────────────

CREATE TABLE "LandingPageVersion" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "landingPageId" INTEGER NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "status" "LandingVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "authority" "LandingVersionAuthority" NOT NULL DEFAULT 'OWNER_SAVED',
  "strategyId" TEXT NOT NULL,
  "strategyType" TEXT NOT NULL,
  "strategyEngineVersion" TEXT NOT NULL,
  "composerVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "composerContextVersion" TEXT NOT NULL,
  "blueprintVersion" TEXT NOT NULL,
  "rendererVersion" TEXT NOT NULL,
  "blueprintSnapshot" JSONB NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "supersedesVersionId" INTEGER,
  "rollbackSourceVersionId" INTEGER,
  "createdByUserId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "approvedByUserId" INTEGER,
  "supersededAt" TIMESTAMP(3),
  "supersededByVersionId" INTEGER,
  "retiredAt" TIMESTAMP(3),
  "retiredByUserId" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LandingPageVersion_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "LandingPageVersion_version_number" CHECK ("versionNumber" > 0),
  CONSTRAINT "LandingPageVersion_created_by" CHECK ("createdByUserId" > 0),

  CONSTRAINT "LandingPageVersion_strategy" CHECK (
    char_length("strategyId") BETWEEN 1 AND 200
    AND "strategyId" ~ '^p3b\.strategy\.v[0-9]+:[A-Z_]+:[A-Z_]+(:[A-Z_]+)?$'
    AND "strategyType" ~ '^[A-Z][A-Z_]{1,59}$'
  ),

  CONSTRAINT "LandingPageVersion_engine_versions" CHECK (
    "strategyEngineVersion" ~ '^p3b\.strategy\.v[0-9]{1,3}$'
    AND "composerVersion" ~ '^p3c\.composer\.v[0-9]{1,3}$'
    AND "promptVersion" ~ '^p3c\.composer-prompt\.v[0-9]{1,3}$'
    AND "composerContextVersion" ~ '^p3c\.composer-context\.v[0-9]{1,3}$'
    AND "blueprintVersion" ~ '^p3c\.blueprint\.v[0-9]{1,3}$'
    AND "rendererVersion" ~ '^p3d\.renderer\.v[0-9]{1,3}$'
  ),

  -- The snapshot is a validated blueprint and nothing else: a JSON object, bounded, with a CLOSED set
  -- of top-level keys, bound to this row's business, strategy and versions, and still a machine
  -- proposal INSIDE (the owner's authority lives on the row, never written into the copy).
  CONSTRAINT "LandingPageVersion_snapshot_shape" CHECK (
    jsonb_typeof("blueprintSnapshot") = 'object'
    AND octet_length("blueprintSnapshot"::text) <= 262144
    AND ("blueprintSnapshot" - ARRAY[
      'version', 'composerVersion', 'promptVersion', 'composerContextVersion', 'strategyEngineVersion',
      'businessId', 'strategyId', 'strategyType', 'authority', 'pageIntent', 'metadata', 'hero', 'sections',
      'primaryAction', 'secondaryAction', 'surfaceOnly', 'offeringRefs', 'trustClaimRefs', 'assetRefs',
      'factRefs', 'statementRefs', 'missingAssets', 'publicationConstraints', 'authorityRefs', 'readiness'
    ]) = '{}'::jsonb
    AND COALESCE("blueprintSnapshot" ->> 'businessId' = "businessId"::text, false)
    AND COALESCE("blueprintSnapshot" ->> 'strategyId' = "strategyId", false)
    AND COALESCE("blueprintSnapshot" ->> 'strategyType' = "strategyType", false)
    AND COALESCE("blueprintSnapshot" ->> 'version' = "blueprintVersion", false)
    AND COALESCE("blueprintSnapshot" ->> 'composerVersion' = "composerVersion", false)
    AND COALESCE("blueprintSnapshot" ->> 'promptVersion' = "promptVersion", false)
    AND COALESCE("blueprintSnapshot" ->> 'composerContextVersion' = "composerContextVersion", false)
    AND COALESCE("blueprintSnapshot" ->> 'strategyEngineVersion' = "strategyEngineVersion", false)
    AND COALESCE("blueprintSnapshot" ->> 'authority' = 'MACHINE_PROPOSAL', false)
    AND COALESCE(jsonb_typeof("blueprintSnapshot" -> 'sections') = 'array', false)
  ),

  CONSTRAINT "LandingPageVersion_fingerprints" CHECK (
    "sourceFingerprint" ~ '^[0-9a-f]{64}$' AND "idempotencyKey" ~ '^[0-9a-f]{64}$'
  ),

  CONSTRAINT "LandingPageVersion_lineage_not_self" CHECK (
    COALESCE("supersedesVersionId" <> "id", true)
    AND COALESCE("rollbackSourceVersionId" <> "id", true)
    AND COALESCE("supersededByVersionId" <> "id", true)
  ),

  -- A CHECK that evaluates to NULL PASSES, so every branch states its NULLs explicitly.
  -- The owner's acts always say when and by whom; the authority follows the act, never a flag.
  CONSTRAINT "LandingPageVersion_status_shape" CHECK (
    (
      "status" = 'DRAFT' AND "authority" = 'OWNER_SAVED'
      AND "approvedAt" IS NULL AND "approvedByUserId" IS NULL
      AND "supersededAt" IS NULL AND "supersededByVersionId" IS NULL
      AND "retiredAt" IS NULL AND "retiredByUserId" IS NULL
      AND "rollbackSourceVersionId" IS NULL
    )
    OR (
      "status" = 'APPROVED' AND "authority" = 'OWNER_APPROVED'
      AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "approvedByUserId" > 0
      AND "supersededAt" IS NULL AND "supersededByVersionId" IS NULL
      AND "retiredAt" IS NULL AND "retiredByUserId" IS NULL
    )
    OR (
      "status" = 'SUPERSEDED'
      AND "supersededAt" IS NOT NULL AND "supersededByVersionId" IS NOT NULL
      AND "retiredAt" IS NULL AND "retiredByUserId" IS NULL
      AND (
        ("authority" = 'OWNER_APPROVED' AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "approvedByUserId" > 0)
        OR ("authority" = 'OWNER_SAVED' AND "approvedAt" IS NULL AND "approvedByUserId" IS NULL AND "rollbackSourceVersionId" IS NULL)
      )
    )
    OR (
      "status" = 'RETIRED' AND "authority" = 'OWNER_SAVED'
      AND "approvedAt" IS NULL AND "approvedByUserId" IS NULL
      AND "supersededAt" IS NULL AND "supersededByVersionId" IS NULL
      AND "retiredAt" IS NOT NULL AND "retiredByUserId" IS NOT NULL AND "retiredByUserId" > 0
      AND "rollbackSourceVersionId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "LandingPageVersion_businessId_id_key" ON "LandingPageVersion"("businessId", "id");
CREATE UNIQUE INDEX "LandingPageVersion_businessId_landingPageId_versionNumber_key" ON "LandingPageVersion"("businessId", "landingPageId", "versionNumber");
CREATE UNIQUE INDEX "LandingPageVersion_businessId_idempotencyKey_key" ON "LandingPageVersion"("businessId", "idempotencyKey");
CREATE INDEX "LandingPageVersion_businessId_status_idx" ON "LandingPageVersion"("businessId", "status");

-- PARTIAL UNIQUE INDEXES (raw SQL, not expressible in Prisma): at most one current draft and one
-- current approved version per page. Superseded and retired rows keep their place as history.
-- Every unique index leads with businessId: a uniqueness check runs BEFORE the foreign keys, and an index
-- keyed on another tenant's page would answer "does B's page have a draft?" to a cross-tenant insert.
CREATE UNIQUE INDEX "LandingPageVersion_one_draft_key" ON "LandingPageVersion"("businessId", "landingPageId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "LandingPageVersion_one_approved_key" ON "LandingPageVersion"("businessId", "landingPageId") WHERE "status" = 'APPROVED';

ALTER TABLE "LandingPageVersion" ADD CONSTRAINT "LandingPageVersion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Tenant-safe: a version belongs to its own business's page (one page per business).
ALTER TABLE "LandingPageVersion" ADD CONSTRAINT "LandingPageVersion_landingPage_fkey"
  FOREIGN KEY ("businessId", "landingPageId") REFERENCES "LandingPage"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Lineage stays inside the tenant.
ALTER TABLE "LandingPageVersion" ADD CONSTRAINT "LandingPageVersion_supersedes_fkey"
  FOREIGN KEY ("businessId", "supersedesVersionId") REFERENCES "LandingPageVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Deferred: the replaced row is marked SUPERSEDED (naming its successor's pre-allocated id) BEFORE the
-- successor is inserted, so the one-draft / one-approved indexes hold at every statement.
ALTER TABLE "LandingPageVersion" ADD CONSTRAINT "LandingPageVersion_supersededBy_fkey"
  FOREIGN KEY ("businessId", "supersededByVersionId") REFERENCES "LandingPageVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LandingPageVersion" ADD CONSTRAINT "LandingPageVersion_rollbackSource_fkey"
  FOREIGN KEY ("businessId", "rollbackSourceVersionId") REFERENCES "LandingPageVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The page's pointers stay inside the tenant (composite FKs, MATCH SIMPLE: a NULL pointer is "none").
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_currentDraft_fkey"
  FOREIGN KEY ("businessId", "currentDraftVersionId") REFERENCES "LandingPageVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_currentApproved_fkey"
  FOREIGN KEY ("businessId", "currentApprovedVersionId") REFERENCES "LandingPageVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 3. Database-enforced lifecycle ───────────────────────────────────────────────────────────

-- A version's CONTENT never changes; only its lifecycle moves, forward, along the closed graph.
-- DELETE is refused for every role; a cascade from the business (trigger depth > 1) is the only removal.
CREATE OR REPLACE FUNCTION public.p3e_landing_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  lifecycle CONSTANT text[] := ARRAY['status', 'authority', 'approvedAt', 'approvedByUserId', 'supersededAt',
                                     'supersededByVersionId', 'retiredAt', 'retiredByUserId', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ931', MESSAGE = 'P3E_IMMUTABLE: a landing version is never deleted';
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ932', MESSAGE = 'P3E_IMMUTABLE: a landing version''s content cannot change; save a new version';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZ933', MESSAGE = 'P3E_LIFECYCLE: a landing version''s lifecycle fields change only with its status';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'SUPERSEDED', 'RETIRED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ933',
      MESSAGE = format('P3E_LIFECYCLE: %s -> %s is not a landing version transition', OLD."status", NEW."status");
  END IF;
  -- Leaving APPROVED keeps the approval record exactly as it was.
  IF OLD."status" = 'APPROVED' AND (
    NEW."authority" IS DISTINCT FROM OLD."authority"
    OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
    OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ933', MESSAGE = 'P3E_LIFECYCLE: an approval record cannot be rewritten';
  END IF;
  RETURN NEW;
END
$fn$;

-- The page's identity never changes and its counter only moves forward.
CREATE OR REPLACE FUNCTION public.p3e_landing_page_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZ931', MESSAGE = 'P3E_IMMUTABLE: a landing page is never deleted';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId"
     OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ932', MESSAGE = 'P3E_IMMUTABLE: a landing page''s identity cannot change';
  END IF;
  IF NEW."lastVersionNumber" < OLD."lastVersionNumber" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ933', MESSAGE = 'P3E_LIFECYCLE: the version counter never moves back';
  END IF;
  RETURN NEW;
END
$fn$;

-- Pointer integrity, checked at COMMIT (deferred): the page's current-draft / current-approved pointers
-- name exactly the page's DRAFT / APPROVED version (or are NULL exactly when there is none), and no
-- version number exceeds the page's counter. SECURITY INVOKER: it sees only what the caller's tenant
-- context lets it see, so a write without the tenant context fails closed.
CREATE OR REPLACE FUNCTION public.p3e_landing_pointer_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  page_id integer;
  pg record;
  draft_id integer;
  approved_id integer;
  max_number integer;
BEGIN
  IF TG_TABLE_NAME = 'LandingPage' THEN
    page_id := NEW."id";
  ELSE
    page_id := NEW."landingPageId";
  END IF;
  SELECT p."id", p."currentDraftVersionId", p."currentApprovedVersionId", p."lastVersionNumber"
    INTO pg FROM "LandingPage" p WHERE p."id" = page_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ934', MESSAGE = 'P3E_POINTER: landing page not visible in this tenant context';
  END IF;
  SELECT v."id" INTO draft_id FROM "LandingPageVersion" v WHERE v."landingPageId" = page_id AND v."status" = 'DRAFT';
  SELECT v."id" INTO approved_id FROM "LandingPageVersion" v WHERE v."landingPageId" = page_id AND v."status" = 'APPROVED';
  SELECT max(v."versionNumber") INTO max_number FROM "LandingPageVersion" v WHERE v."landingPageId" = page_id;
  IF pg."currentDraftVersionId" IS DISTINCT FROM draft_id THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ934', MESSAGE = 'P3E_POINTER: the current-draft pointer does not name the page''s DRAFT version';
  END IF;
  IF pg."currentApprovedVersionId" IS DISTINCT FROM approved_id THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ934', MESSAGE = 'P3E_POINTER: the current-approved pointer does not name the page''s APPROVED version';
  END IF;
  IF COALESCE(max_number, 0) > pg."lastVersionNumber" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ934', MESSAGE = 'P3E_POINTER: a version number exceeds the page''s counter';
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.p3e_landing_version_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p3e_landing_page_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p3e_landing_pointer_integrity() FROM PUBLIC;

CREATE TRIGGER "LandingPageVersion_guard" BEFORE UPDATE OR DELETE ON "LandingPageVersion"
  FOR EACH ROW EXECUTE FUNCTION public.p3e_landing_version_guard();
CREATE TRIGGER "LandingPage_guard" BEFORE UPDATE OR DELETE ON "LandingPage"
  FOR EACH ROW EXECUTE FUNCTION public.p3e_landing_page_guard();
CREATE CONSTRAINT TRIGGER "LandingPage_pointer_integrity" AFTER INSERT OR UPDATE ON "LandingPage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.p3e_landing_pointer_integrity();
CREATE CONSTRAINT TRIGGER "LandingPageVersion_pointer_integrity" AFTER INSERT OR UPDATE ON "LandingPageVersion"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.p3e_landing_pointer_integrity();

-- ── 4. Tenant isolation: per-command policies, no FOR ALL, no DELETE policy ──────────────────

ALTER TABLE "LandingPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LandingPage" FORCE ROW LEVEL SECURITY;

CREATE POLICY p3e_landing_page_select ON "LandingPage" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- A page is born empty: no pointer, counter at zero.
CREATE POLICY p3e_landing_page_insert ON "LandingPage" FOR INSERT
  WITH CHECK (
    "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
    AND "currentDraftVersionId" IS NULL AND "currentApprovedVersionId" IS NULL
    AND "lastVersionNumber" = 0
  );

CREATE POLICY p3e_landing_page_update ON "LandingPage" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "LandingPageVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LandingPageVersion" FORCE ROW LEVEL SECURITY;

CREATE POLICY p3e_landing_version_select ON "LandingPageVersion" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- A version enters as an owner-saved DRAFT, or — only as a rollback — directly APPROVED. Never
-- SUPERSEDED or RETIRED, and never approved without naming the version it restores.
CREATE POLICY p3e_landing_version_insert ON "LandingPageVersion" FOR INSERT
  WITH CHECK (
    "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
    AND (
      ("status" = 'DRAFT' AND "rollbackSourceVersionId" IS NULL)
      OR ("status" = 'APPROVED' AND "rollbackSourceVersionId" IS NOT NULL)
    )
  );

-- Only a live (DRAFT / APPROVED) row of the tenant can move; SUPERSEDED and RETIRED rows are frozen.
CREATE POLICY p3e_landing_version_update ON "LandingPageVersion" FOR UPDATE
  USING (
    "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
    AND "status" IN ('DRAFT', 'APPROVED')
  )
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Runtime privileges, named explicitly (the owner's default ACL would otherwise hand app_runtime
-- DELETE, TRUNCATE and a table-wide UPDATE). UPDATE is column-scoped: pointers + counter on the page;
-- lifecycle columns only on a version. Snapshot, strategy, versions, fingerprints, idempotency key,
-- lineage-at-creation, creator and tenant are immutable.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "LandingPage" FROM app_runtime;
    GRANT SELECT, INSERT ON "LandingPage" TO app_runtime;
    GRANT UPDATE ("currentDraftVersionId", "currentApprovedVersionId", "lastVersionNumber", "updatedAt")
      ON "LandingPage" TO app_runtime;
    REVOKE ALL ON SEQUENCE "LandingPage_id_seq" FROM app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "LandingPage_id_seq" TO app_runtime;

    REVOKE ALL ON "LandingPageVersion" FROM app_runtime;
    GRANT SELECT, INSERT ON "LandingPageVersion" TO app_runtime;
    GRANT UPDATE (
      "status", "authority", "approvedAt", "approvedByUserId",
      "supersededAt", "supersededByVersionId", "retiredAt", "retiredByUserId", "updatedAt"
    ) ON "LandingPageVersion" TO app_runtime;
    REVOKE ALL ON SEQUENCE "LandingPageVersion_id_seq" FROM app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "LandingPageVersion_id_seq" TO app_runtime;
  END IF;
END
$do$;

REVOKE ALL ON "LandingPage" FROM PUBLIC;
REVOKE ALL ON "LandingPageVersion" FROM PUBLIC;
