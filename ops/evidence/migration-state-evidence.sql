-- Read-only Production evidence: Prisma migration-history state.
--
-- WHY THIS EXISTS
--
-- On the DEV Neon branch `_prisma_migrations` was found to hold 3 rows against
-- 94 migration files on disk, with `20260329225659_init` recorded as started
-- and never finished. That single unfinished row makes `prisma migrate deploy`
-- fail with P3009, which is how the drift was discovered at all.
--
-- Whether Production is in the same condition is NOT known. The repo asserts it
-- is "baselined" (.github/workflows/release-migrate.yml), but that assertion is
-- prose in a workflow file, not an observation. This file is the observation.
--
-- It answers exactly three questions and asks nothing else:
--   Q1  how many migration rows exist, and how many are unfinished or rolled back
--   Q2  which rows those are, if any
--   Q3  whether BusinessProfile."billingPaymentTermsDays" is already present
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always ROLLBACKs, with a
-- session read-only guard and a statement timeout. This file must never contain
-- a write statement; a CI guard rejects it before it ever reaches the database.
--
-- No business data is read: `_prisma_migrations` and `information_schema` hold
-- schema metadata only, so this cannot expose customer or financial records.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q1: migration ledger totals =='
SELECT count(*)                                            AS total,
       count(*) FILTER (WHERE finished_at IS NULL)         AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)  AS rolled_back
FROM _prisma_migrations;

\echo '== Q2: unfinished or rolled-back migrations (expected: zero rows) =='
SELECT migration_name, started_at, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at;

\echo '== Q3: does BusinessProfile.billingPaymentTermsDays already exist? =='
SELECT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_name = 'BusinessProfile'
    AND column_name = 'billingPaymentTermsDays'
) AS column_already_exists;

ROLLBACK;
