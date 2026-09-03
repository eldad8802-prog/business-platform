-- Import & Export Center / I-6 — the bulk-import execution ledger.
--
-- EXPAND-ONLY: two new tables and three new enums. No existing table is altered,
-- no column is dropped, no NOT NULL is added to anything that exists, and there is
-- no backfill. A pre-existing database is unaffected until the first import runs.
--
-- WHY THE ROW TABLE EXISTS
-- Supplier and InventoryItem CREATE are not idempotent — neither table carries a
-- uniqueness constraint — and an inventory create additionally writes an
-- INITIAL_STOCK movement into the ledger. A process that dies after committing a
-- batch of 200 would, on retry, create all 200 records a second time. "ImportRunRow"
-- is the durable evidence that prevents it, and the executor writes it in the SAME
-- transaction as the business record, so the pair can never disagree: either both
-- committed or neither did.
--
-- WHY THE ROW PRIMARY KEY IS COMPOSITE
-- PRIMARY KEY ("importRunId", "sourceRowNumber") IS the idempotency mechanism, not
-- an index choice. A repeated or concurrent attempt to mark the same row fails on
-- INSERT rather than racing to a second write.
--
-- WHY "sourceRowNumber" IS A SUFFICIENT ROW IDENTITY
-- The parent run is unique on (businessId, contentHash, mappingHash, decisionsHash),
-- and contentHash is the SHA-256 of the exact uploaded bytes. Within one run the file
-- cannot differ, so row N is deterministically the same row. A per-row fingerprint was
-- considered and REJECTED: over low-entropy PII (an Israeli mobile is a ~10^8 space) a
-- stored digest is brute-forceable offline, which would put recoverable customer
-- identity into the one table whose whole purpose is to hold none.
--
-- WHAT THIS LEDGER DELIBERATELY DOES NOT STORE
-- No uploaded file, no row values, no names, phones, emails, SKUs, barcodes,
-- quantities or prices, no normalized payload, and no reference to any existing
-- record that was matched. Every column is an id, a foreign key, a digest of inputs
-- the server already held transiently, an enum, a short error code, or a timestamp.
--
-- COUNTS ARE AN AUDIT SNAPSHOT, NOT EXECUTION AUTHORITY
-- While a run is EXECUTING the rows are the only truth about what ran. The three
-- counters are written ONCE, at terminalization, so the run can still report what it
-- did after its rows are cleaned up at the end of the 30-day retry window. They are
-- never read to decide whether a row should execute.

-- ============================================================
-- 1. Enums
-- ============================================================
CREATE TYPE "ImportRunStatus" AS ENUM ('EXECUTING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "ImportRowAction" AS ENUM ('CREATE', 'SKIP');
CREATE TYPE "ImportRowStatus" AS ENUM ('CREATED', 'SKIPPED', 'FAILED');

-- ============================================================
-- 2. Tables
-- ============================================================
CREATE TABLE "ImportRun" (
    "id"            SERIAL            NOT NULL,
    "businessId"    INTEGER           NOT NULL,
    "userId"        INTEGER           NOT NULL,
    "domain"        TEXT              NOT NULL,
    "contentHash"   TEXT              NOT NULL,
    "mappingHash"   TEXT              NOT NULL,
    "decisionsHash" TEXT              NOT NULL,
    "sheetName"     TEXT,
    "status"        "ImportRunStatus" NOT NULL DEFAULT 'EXECUTING',
    "totalRows"     INTEGER           NOT NULL,
    "createdCount"  INTEGER,
    "skippedCount"  INTEGER,
    "failedCount"   INTEGER,
    "startedAt"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"   TIMESTAMP(3),

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportRunRow" (
    "importRunId"     INTEGER           NOT NULL,
    "sourceRowNumber" INTEGER           NOT NULL,
    "action"          "ImportRowAction" NOT NULL,
    "status"          "ImportRowStatus" NOT NULL,
    "errorCode"       TEXT,
    "executedAt"      TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRunRow_pkey" PRIMARY KEY ("importRunId", "sourceRowNumber")
);

-- ============================================================
-- 3. Keys and indexes
-- ============================================================

-- THE idempotency key. Survives the 30-day row cleanup, so a completed import can
-- never become silently replayable once its retry scaffolding is gone.
CREATE UNIQUE INDEX "ImportRun_businessId_contentHash_mappingHash_decisionsHash_key"
  ON "ImportRun"("businessId", "contentHash", "mappingHash", "decisionsHash");

CREATE INDEX "ImportRun_businessId_status_idx" ON "ImportRun"("businessId", "status");
CREATE INDEX "ImportRun_businessId_startedAt_idx" ON "ImportRun"("businessId", "startedAt");
CREATE INDEX "ImportRunRow_importRunId_status_idx" ON "ImportRunRow"("importRunId", "status");

ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportRunRow" ADD CONSTRAINT "ImportRunRow_importRunId_fkey"
  FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 4. Tenant RLS — the canonical D2/P7 treatment
--
-- Fail-closed predicate, unchanged from every prior wave:
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
-- With no GUC set, current_setting(..., true) returns '', NULLIF yields NULL, and the
-- comparison is NULL — so no row qualifies.
--
-- DELETE IS GRANTED HERE, unlike the P4-B pilot tables, because this ledger has TWO
-- real delete consumers and a policy is written only where a consumer exists:
--   1. the 30-day retention cleanup of ImportRunRow, and
--   2. account/business erasure, which must remove both tables.
-- Writing no DELETE policy would make the retention policy unimplementable and would
-- strand import evidence inside a deleted business.
--
-- NO ADMIN POLICY. There is no platform-admin consumer of either table: zero
-- consumers, zero privilege. Adding `p7adm_read` "for symmetry" would grant a
-- cross-tenant read that nothing asks for.
-- ============================================================
ALTER TABLE "ImportRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportRun" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7imp_tenant_read ON "ImportRun";
CREATE POLICY p7imp_tenant_read ON "ImportRun" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_insert ON "ImportRun";
CREATE POLICY p7imp_tenant_insert ON "ImportRun" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_update ON "ImportRun";
CREATE POLICY p7imp_tenant_update ON "ImportRun" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_delete ON "ImportRun";
CREATE POLICY p7imp_tenant_delete ON "ImportRun" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ImportRunRow carries no businessId of its own: its tenant is its parent's, and the
-- FK with ON DELETE CASCADE makes that structural. The predicate therefore reaches
-- through the parent — a row is visible exactly when its run is.
ALTER TABLE "ImportRunRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportRunRow" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7imp_row_tenant_read ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_read ON "ImportRunRow" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

DROP POLICY IF EXISTS p7imp_row_tenant_insert ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_insert ON "ImportRunRow" FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

DROP POLICY IF EXISTS p7imp_row_tenant_delete ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_delete ON "ImportRunRow" FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

-- No UPDATE policy on ImportRunRow. A marker records what happened; rewriting one
-- would rewrite history, and the executor only ever inserts. The capability simply
-- does not exist.

-- ============================================================
-- 5. Grants for the env-neutral runtime group role (NOLOGIN, created by earlier
--    waves). Guarded so this migration stays environment-portable.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ImportRun" TO app_runtime;
    GRANT SELECT, INSERT, DELETE ON "ImportRunRow" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "ImportRun_id_seq" TO app_runtime;

    -- Not granting UPDATE is not the same as not having it. This project's
    -- databases carry ALTER DEFAULT PRIVILEGES granting app_runtime a,r,w,d on
    -- every NEW table, so ImportRunRow arrives holding an UPDATE privilege that
    -- was never asked for. Measured on a real branch, not assumed:
    --   relacl -> {neondb_owner=arwdDxtm/...,app_runtime=arwd/...}
    --
    -- Row-level security still refuses the update, because the table has no
    -- UPDATE policy — but a marker's immutability should not rest on a single
    -- mechanism. The privilege is removed so the grant and the policy agree.
    REVOKE UPDATE ON "ImportRunRow" FROM app_runtime;
  END IF;
END
$$;
