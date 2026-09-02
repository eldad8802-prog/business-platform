-- Read-only Production evidence: did the auth token-version expand step land?
--
-- WHY THIS EXISTS
--
-- `migration-state-evidence.sql` answers only in COUNTS. It can say "112 rows
-- in the ledger", which lets you infer what landed by arithmetic, but it never
-- names a migration unless that migration is broken. After applying a schema
-- change that a later release will depend on, an inference is not good enough:
-- the question "is the column really there, with the shape the application
-- expects" has to be answered by looking at the column.
--
-- So this file names the migration it is checking, and reads the actual column
-- definition out of information_schema rather than trusting the migration file.
--
-- It answers five questions and asks nothing else:
--   E1  is `20260902100000_auth_token_version` in the ledger, and did it finish
--   E2  is any migration in the ledger unfinished or reversed
--   E3  ledger totals
--   E4  the true shape of "User"."tokenVersion" as PostgreSQL reports it
--   E5  whether every existing row got generation 0
--
-- PRIVACY: E5 is aggregate-only — row counts and the range of a single integer
-- generation counter. No name, address, email, password or business record is
-- ever selected. E1-E4 read schema metadata, which holds no customer data at
-- all.
--
-- SELECT-only, inside a READ ONLY transaction that always ends by unwinding,
-- with a session-level read-only guard and a statement timeout. A CI guard
-- rejects this file if it contains any write keyword, so the wording here
-- deliberately avoids those words even in prose.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== E1: the token-version migration, by name =='
SELECT migration_name,
       started_at,
       finished_at,
       rolled_back_at,
       (finished_at IS NOT NULL) AS finished_ok,
       (rolled_back_at IS NULL)  AS not_reversed
FROM _prisma_migrations
WHERE migration_name = '20260902100000_auth_token_version';

\echo '== E2: any unfinished or reversed migration (expected: zero rows) =='
SELECT migration_name, started_at, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at;

\echo '== E3: ledger totals =='
SELECT count(*)                                           AS total,
       count(*) FILTER (WHERE finished_at IS NULL)        AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS reversed
FROM _prisma_migrations;

\echo '== E4: true shape of "User"."tokenVersion" =='
SELECT column_name,
       data_type,
       is_nullable,
       column_default,
       numeric_precision
FROM information_schema.columns
WHERE table_name = 'User'
  AND column_name = 'tokenVersion';

\echo '== E5: generation backfill — aggregate only, no row data =='
SELECT count(*)                                            AS user_rows,
       count(*) FILTER (WHERE "tokenVersion" IS NULL)      AS null_generation,
       min("tokenVersion")                                 AS min_generation,
       max("tokenVersion")                                 AS max_generation
FROM "User";

ROLLBACK;
