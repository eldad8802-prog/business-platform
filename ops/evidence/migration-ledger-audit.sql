-- Read-only Production evidence: is every migration the repository holds also
-- present and finished in the Production ledger, and is the ledger holding any
-- migration the repository has never seen?
--
-- WHY THIS FILE EXISTS
--
-- `migration-state-evidence.sql` answers how MANY rows the ledger holds and
-- which of them never finished. That is enough to see a stuck migration and not
-- enough to see a SWAP: a ledger of exactly the right size can still be missing
-- one migration while holding another the repository never had. Counting cannot
-- separate those two worlds; only names can.
--
-- Two migrations reached `main` through unrelated pull requests, and whether
-- Production has them has never been observed:
--
--   20260909020000_add_payplus_provider
--   20260913120000_authsession_user_agent
--
-- Q1 and Q2 ask about those two by name, and report every ledger column that
-- bears on "finished successfully" rather than merely "a row exists". Q3
-- restates the totals so this file stands on its own. Q4 lists every migration
-- name the ledger holds, in order, so the repository listing can be checked
-- against it line by line — the only way to see BOTH directions of a mismatch.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always ROLLBACKs, with a
-- session read-only guard and a statement timeout. A CI guard rejects this file
-- before it ever reaches the database if it bears a write keyword anywhere,
-- string literals and prose included.
--
-- No business data is read: `_prisma_migrations` bears schema metadata only, so
-- this cannot expose customer or financial records.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q1: 20260909020000_add_payplus_provider =='
SELECT migration_name,
       checksum,
       started_at,
       finished_at,
       applied_steps_count,
       rolled_back_at,
       (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied_ok
FROM _prisma_migrations
WHERE migration_name = '20260909020000_add_payplus_provider';

\echo '== Q2: 20260913120000_authsession_user_agent =='
SELECT migration_name,
       checksum,
       started_at,
       finished_at,
       applied_steps_count,
       rolled_back_at,
       (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied_ok
FROM _prisma_migrations
WHERE migration_name = '20260913120000_authsession_user_agent';

\echo '== Q3: ledger totals (unfinished and reversed expected zero) =='
SELECT count(*)                                                                  AS total_rows,
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished_ok,
       count(*) FILTER (WHERE finished_at IS NULL)                                AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)                         AS reversed
FROM _prisma_migrations;

\echo '== Q4: every migration name in the ledger, in order =='
SELECT row_number() OVER (ORDER BY migration_name)                AS n,
       migration_name,
       (finished_at IS NOT NULL AND rolled_back_at IS NULL)       AS applied_ok
FROM _prisma_migrations
ORDER BY migration_name;

ROLLBACK;
