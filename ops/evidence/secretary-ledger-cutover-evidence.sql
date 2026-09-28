-- Phase 2 authority cutover: Production evidence for the secretary ledger.
--
-- SELECT-only (the evidence workflow refuses the file otherwise). Scope:
--   * whole-table baselines, as counts and maxima only
--   * the QA tenant ONLY: business 38 (COLLECTION_QA_BUSINESS_ID), and only
--     commitments whose title starts with the marker QA-P2
--   * catalog facts that make retries safe
--   (the tenant-isolation probe is a separate workflow, run AS the application
--    runtime login itself: prod-readonly-evidence-runtime-rls)
-- No name, note or amount of any other business is selected.
--
-- Run it before the owner flips SECRETARY_LEDGER_STORE and again after the QA
-- scenarios; the difference between the two runs is the evidence.

SET default_transaction_read_only = on;

\echo '== Q1 whole-table baseline (counts only)'
SELECT now()                                                    AS observed_at,
       (SELECT count(*)      FROM "BusinessObligation")         AS legacy_obligations,
       (SELECT max("id")     FROM "BusinessObligation")         AS legacy_max_id,
       (SELECT max("updatedAt") FROM "BusinessObligation")      AS legacy_last_change,
       (SELECT count(*)      FROM "Commitment")                 AS commitments,
       (SELECT count(*)      FROM "Installment")                AS installments,
       (SELECT count(*)      FROM "InstallmentWorkflow")        AS workflow_rows,
       (SELECT count(*)      FROM "Payment")                    AS payments,
       (SELECT count(*)      FROM "PaymentAllocation")          AS allocations;

\echo '== Q2 legacy rows of the QA tenant (must not grow after the switch)'
SELECT count(*) AS qa_legacy_obligations, max("id") AS qa_legacy_max_id, max("updatedAt") AS qa_legacy_last_change
FROM "BusinessObligation" WHERE "businessId" = 38;

\echo '== Q3 QA-P2 commitments (business 38)'
SELECT c."id", c."businessId", c."scheduleKind", c."recurrence", c."status", c."totalAmount", c."endAt",
       c."legacyObligationId", c."recurrenceSeriesId" IS NOT NULL AS has_series, c."createdAt"
FROM "Commitment" c
WHERE c."businessId" = 38 AND c."title" LIKE 'QA-P2%'
ORDER BY c."id";

\echo '== Q4 their installments'
SELECT i."id", i."commitmentId", i."businessId", i."sequence", i."dueAt", i."scheduledAmount", i."status", i."createdAt", i."updatedAt"
FROM "Installment" i
JOIN "Commitment" c ON c."id" = i."commitmentId"
WHERE c."businessId" = 38 AND c."title" LIKE 'QA-P2%'
ORDER BY i."commitmentId", i."sequence";

\echo '== Q5 their workflow rows (snooze / handled)'
SELECT w."installmentId", w."businessId", w."followUpAt", w."handledAt", w."handledByUserId" IS NOT NULL AS handled_by_user, w."createdAt", w."updatedAt"
FROM "InstallmentWorkflow" w
JOIN "Installment" i ON i."id" = w."installmentId"
JOIN "Commitment" c ON c."id" = i."commitmentId"
WHERE c."businessId" = 38 AND c."title" LIKE 'QA-P2%'
ORDER BY w."installmentId";

\echo '== Q6 payments against them (and any secretary-keyed payment of business 38)'
SELECT DISTINCT p."id", p."businessId", p."amount", p."paidAt", p."status", p."method", p."idempotencyKey", p."createdAt"
FROM "Payment" p
LEFT JOIN "PaymentAllocation" a ON a."paymentId" = p."id"
LEFT JOIN "Installment" i ON i."id" = a."installmentId"
LEFT JOIN "Commitment" c ON c."id" = i."commitmentId"
WHERE p."businessId" = 38 AND ((c."title" LIKE 'QA-P2%') OR p."idempotencyKey" LIKE 'secretary:%')
ORDER BY p."id";

\echo '== Q7 their allocations'
SELECT a."id", a."paymentId", a."installmentId", a."businessId", a."allocatedAmount", a."reversedAt"
FROM "PaymentAllocation" a
JOIN "Installment" i ON i."id" = a."installmentId"
JOIN "Commitment" c ON c."id" = i."commitmentId"
WHERE c."businessId" = 38 AND c."title" LIKE 'QA-P2%'
ORDER BY a."id";

\echo '== Q8 duplicates (every value must be 0)'
SELECT
  (SELECT count(*) FROM (
     SELECT i."commitmentId", i."dueAt" FROM "Installment" i
     JOIN "Commitment" c ON c."id" = i."commitmentId"
     WHERE c."businessId" = 38 AND c."title" LIKE 'QA-P2%' AND i."status" <> 'CANCELLED'
     GROUP BY i."commitmentId", i."dueAt" HAVING count(*) > 1) d)                     AS duplicate_live_occurrences,
  (SELECT count(*) FROM (
     SELECT "idempotencyKey" FROM "Payment" WHERE "businessId" = 38 AND "idempotencyKey" IS NOT NULL
     GROUP BY "idempotencyKey" HAVING count(*) > 1) d)                                  AS duplicate_payment_keys,
  (SELECT count(*) FROM (
     SELECT "title" FROM "Commitment" WHERE "businessId" = 38 AND "title" LIKE 'QA-P2%'
     GROUP BY "title" HAVING count(*) > 1) d)                                           AS duplicate_qa_commitment_titles,
  (SELECT count(*) FROM "InstallmentWorkflow" w JOIN "Installment" i ON i."id" = w."installmentId"
     WHERE w."businessId" <> i."businessId")                                            AS workflow_business_mismatch,
  (SELECT count(*) FROM "Installment" i JOIN "Commitment" c ON c."id" = i."commitmentId"
     WHERE i."businessId" <> c."businessId")                                            AS installment_business_mismatch;

\\echo '== Q9 catalog: what makes retries safe (by index IDENTITY), and RLS on the authority tables'
SELECT c.relname AS index_name,
       i.indisunique AS is_unique,
       t.relname AS on_table,
       array_agg(a.attname::text ORDER BY k.ord) AS key_columns,
       pg_get_expr(i.indpred, i.indrelid) AS partial_predicate
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_class t ON t.oid = i.indrelid
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
WHERE c.relkind = 'i'
  AND c.relname IN ('Payment_businessId_idempotencyKey_key',
                    'Installment_commitmentId_sequence_key',
                    'PaymentAllocation_active_payment_installment_key')
GROUP BY c.relname, i.indisunique, t.relname, i.indpred, i.indrelid
ORDER BY c.relname;

SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('Commitment','Installment','InstallmentWorkflow','Payment','PaymentAllocation','BusinessObligation')
          AND relrowsecurity AND relforcerowsecurity) AS tables_with_forced_rls_of_6;

\echo '== Q10 is NOT in this file: the tenant-isolation probe runs through the application runtime login'
\echo '==     (workflow prod-readonly-evidence-runtime-rls, scripts/ops/runtime-rls-evidence.ts)'
