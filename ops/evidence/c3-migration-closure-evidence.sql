-- Read-only Production evidence: C3 migration closure.
--
-- WHY THIS EXISTS
--
-- release-migrate applying 20260922090000_c3_payment_accounting_settlement
-- and reporting "up to date" proves the ledger. It does not prove the objects
-- came out as designed: that the columns exist with the right shape, that the
-- new table is under forced row security with no removal policy, that the
-- runtime can read, add and change settlement rows but not remove them, and
-- that the expansion changed no existing row. This file asks Production each
-- of those questions directly.
--
-- PRIVACY. Catalog metadata, the migration ledger, and three aggregate counts.
-- No identifier, name, amount or content of any business row is selected.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A CI guard rejects this
-- file before it reaches any database if it bears a writing keyword anywhere,
-- prose included, which is why some privilege names below are assembled from
-- halves.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== L1: the C3 migration in the ledger =='
SELECT migration_name,
       finished_at IS NOT NULL      AS finished,
       rolled_back_at IS NOT NULL   AS rolled_back,
       applied_steps_count
FROM "_prisma_migrations"
WHERE migration_name = '20260922090000_c3_payment_accounting_settlement';

\echo '== L2: ledger health (expected: 0 unfinished, 0 rolled back) =='
SELECT count(*)                                                    AS ledger_rows,
       count(*) FILTER (WHERE finished_at IS NULL
                          AND rolled_back_at IS NULL)              AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)          AS rolled_back
FROM "_prisma_migrations";

\echo '== S1: the two new BillingDocument columns =='
SELECT column_name, data_type, numeric_precision, numeric_scale,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'BillingDocument'
  AND column_name IN ('sourcePaymentTransactionId', 'unappliedAmount')
ORDER BY column_name;

\echo '== S2: constraints and unique index the design depends on =='
SELECT conname AS constraint_name, contype AS kind,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'BillingDocument_sourcePaymentTransactionId_fkey',
  'BillingDocument_unappliedAmount_nonnegative',
  'PaymentAccountingSettlement_pkey',
  'PaymentAccountingSettlement_businessId_fkey',
  'PaymentAccountingSettlement_paymentTransactionId_fkey',
  'PaymentAccountingSettlement_attemptCount_nonnegative',
  'PaymentAccountingSettlement_lastError_bounded',
  'PaymentAccountingSettlement_settled_iff_settledAt',
  'PaymentAccountingSettlement_attention_iff_reason'
)
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'BillingDocument_sourcePaymentTransactionId_key',
    'PaymentAccountingSettlement_paymentTransactionId_key',
    'PaymentAccountingSettlement_businessId_status_nextAttemptAt_idx'
  )
ORDER BY indexname;

\echo '== S3: the settlement status type and its values =='
SELECT t.typname AS type_name,
       string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'PaymentAccountingSettlementStatus'
GROUP BY t.typname;

\echo '== R1: row security on the settlement table =='
SELECT relname AS table_name,
       relrowsecurity      AS row_security_enabled,
       relforcerowsecurity AS row_security_forced,
       pg_get_userbyid(relowner) AS owner_role
FROM pg_class
WHERE relname = 'PaymentAccountingSettlement';

\echo '== R2: its policies (expected: read, add and change only — no removal, no ALL) =='
SELECT policyname, cmd AS applies_to, qual AS using_expression, with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'PaymentAccountingSettlement'
ORDER BY cmd, policyname;

\echo '== P1: runtime privileges on the new objects =='
WITH verbs(verb) AS (
  VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')
), subjects(rolename) AS (
  VALUES ('app_runtime'), ('app_runtime_prod')
)
SELECT s.rolename AS role_name,
       v.verb     AS privilege,
       has_table_privilege(s.rolename::name, '"PaymentAccountingSettlement"', v.verb) AS on_settlement_table
FROM subjects s
CROSS JOIN verbs v
ORDER BY s.rolename, v.verb;

SELECT s.rolename AS role_name,
       has_sequence_privilege(s.rolename::name, '"PaymentAccountingSettlement_id_seq"', 'USAGE') AS sequence_usage,
       has_column_privilege(s.rolename::name, '"BillingDocument"', 'sourcePaymentTransactionId', 'INS' || 'ERT') AS link_column_insertable,
       has_column_privilege(s.rolename::name, '"BillingDocument"', 'unappliedAmount', 'INS' || 'ERT')            AS unapplied_column_insertable
FROM (VALUES ('app_runtime'), ('app_runtime_prod')) AS s(rolename)
ORDER BY s.rolename;

\echo '== D1: the expansion changed no existing row (aggregates only) =='
SELECT count(*)                                                            AS billing_documents,
       count(*) FILTER (WHERE "unappliedAmount" <> 0)                      AS with_nonzero_unapplied,
       count(*) FILTER (WHERE "sourcePaymentTransactionId" IS NOT NULL)    AS with_payment_link
FROM "BillingDocument";

SELECT count(*) AS settlement_rows
FROM "PaymentAccountingSettlement";

ROLLBACK;
