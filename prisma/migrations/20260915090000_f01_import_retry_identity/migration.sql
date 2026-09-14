-- F-01 — an identical import retry could write a keyless row twice.
--
-- WHY THIS EXISTS
--
-- `ImportRun` was unique on (businessId, contentHash, mappingHash, decisionsHash)
-- and that last column is the defect. Decisions are DERIVED FROM THE DATABASE:
-- a source row that collides with an existing record defaults to SKIP, one that
-- does not defaults to CREATE. So the first import changes what the second one
-- decides, `decisionsHash` moves, the unique key no longer matches, a second run
-- opens, and `ImportRunRow`'s (importRunId, sourceRowNumber) marker — which was
-- the real protection — no longer applies. A row with no business key, nothing
-- else to identify it by, was created a second time.
--
-- An idempotency key must not be computed from state the operation mutates.
--
-- WHAT THIS DOES
--
-- Adds `retryKey`, a sha256 of businessId + contentHash + mappingHash, and makes
-- it unique. The same file, mapped the same way, in the same business, is one
-- run again — whatever the decisions look like the second time. The marker
-- primary key then becomes a true cross-retry identity, with no new mechanism.
--
-- WHY THE COLUMN IS NULLABLE
--
-- Every run that predates this migration keeps NULL, and PostgreSQL treats NULLs
-- as distinct in a unique index. So the index builds on ANY existing data —
-- including the duplicate runs F-01 has already produced — without a backfill,
-- without reconciling history, and without deleting anything. Runs written after
-- this migration always carry a key, so the guarantee is total going forward.
--
-- Expand-only: one nullable column, one index added, one now-redundant unique
-- index dropped. No column is removed, no data is rewritten, nothing is deleted.
-- The old index is replaced by a non-unique one on the same leading columns so
-- lookups by file identity stay indexed.

ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "retryKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ImportRun_retryKey_key"
  ON "ImportRun" ("retryKey");

CREATE INDEX IF NOT EXISTS "ImportRun_businessId_contentHash_mappingHash_idx"
  ON "ImportRun" ("businessId", "contentHash", "mappingHash");

DROP INDEX IF EXISTS "ImportRun_businessId_contentHash_mappingHash_decisionsHash_key";

-- The runtime already holds INSERT/UPDATE on this table; a new column on an
-- existing table inherits the table grant, so nothing is granted here. The
-- guarded block mirrors the project's convention of never assuming a role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "ImportRun" TO app_runtime;
  END IF;
END
$$;
