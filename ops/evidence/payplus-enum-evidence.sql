-- Read-only Production evidence: is the PAYPLUS value really in the
-- PaymentProvider enum, and is its migration really recorded as applied.
--
-- WHY THIS EXISTS
--
-- Migration 20260909020000_add_payplus_provider was applied to Production by
-- release-migrate run 34382968834, whose post-status reported "Database schema
-- is up to date!". That is the migration LEDGER speaking. It is strong, but it
-- is not the same statement as "the enum in the live catalog carries the label".
-- A ledger row proves a file was executed; only the catalog proves the shape of
-- the type. This file reads the catalog.
--
-- It also answers the safety question that matters more than the schema one:
-- whether anything is actually STORED against PayPlus. The expectation is zero,
-- because the adapter is not merged and the provider is not an enabled
-- capability, so the widened type should be entirely unused.
--
-- WHAT IT WILL NOT ATTEMPT
--
-- No row is written to test the enum. Writing one would prove the label exists
-- by using it, which is precisely the mutation that must never happen for a
-- provider nobody has approved for use. `pg_enum` answers the question without
-- touching a single business table.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A static guard in the
-- workflow rejects write keywords before any database connection is opened.
--
-- No customer or financial records are read. Q1-Q3 read `pg_enum`/`pg_type`,
-- which hold type metadata. Q4-Q5 read `_prisma_migrations`. Q6 returns row
-- COUNTS per provider and no field of any row.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q1: every label of the PaymentProvider enum, in sort order =='
SELECT e.enumsortorder, e.enumlabel
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'PaymentProvider'
ORDER BY e.enumsortorder;

\echo '== Q2: is PAYPLUS present in the live type? (expected: t) =='
SELECT EXISTS (
  SELECT 1
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'PaymentProvider'
    AND e.enumlabel = 'PAYPLUS'
) AS payplus_present;

\echo '== Q3: label count (expected: 4 — TRANZILA, CARDCOM, PAYPAL, PAYPLUS) =='
SELECT count(*) AS label_count
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'PaymentProvider';

\echo '== Q4: the ledger row for this migration (expected: finished, not rolled back) =='
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
FROM _prisma_migrations
WHERE migration_name = '20260909020000_add_payplus_provider';

\echo '== Q5: ledger health totals (expected: unfinished 0, rolled_back 0) =='
SELECT count(*)                                           AS total,
       count(*) FILTER (WHERE finished_at IS NULL)        AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
FROM _prisma_migrations;

\echo '== Q6: rows stored per provider — COUNTS ONLY (expected: zero for PAYPLUS) =='
SELECT provider, count(*) AS connection_rows
FROM "BusinessPaymentConnection"
GROUP BY provider
ORDER BY provider;

SELECT provider, count(*) AS request_rows
FROM "PaymentRequest"
GROUP BY provider
ORDER BY provider;

SELECT provider, count(*) AS transaction_rows
FROM "PaymentTransaction"
GROUP BY provider
ORDER BY provider;

ROLLBACK;
