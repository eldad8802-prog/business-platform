-- Accounts Payable Phase 1a · Production read-only evidence.
--
-- Purpose: prove that Production carries the shape PR #450's code expects, BEFORE that code is
-- merged. Every question the owner asked is answered here from the live database rather than
-- inferred from a CI run against a container.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that rolls back; session read-only; statement
-- timeout. A CI static guard rejects any write keyword before this ever reaches the database.
--
-- No tenant or customer data is emitted. Every result is a structural fact or an aggregate count
-- across all tenants; no business id, payee name, obligee name, note or amount is selected.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q0: which database is answering =='
SELECT current_database() AS database, inet_server_addr() IS NOT NULL AS has_server_addr, version() AS server_version;

\echo '== Q1: the three Phase 1a migrations are recorded as finished and not rolled back =='
SELECT migration_name,
       (finished_at IS NOT NULL) AS finished,
       (rolled_back_at IS NOT NULL) AS was_rolled_back,
       applied_steps_count
FROM _prisma_migrations
WHERE migration_name LIKE '20260917%payables_phase_1a%'
ORDER BY migration_name;

\echo '== Q2: nothing else was applied in the same window =='
SELECT count(*) AS migrations_applied_since_20260917
FROM _prisma_migrations
WHERE migration_name >= '20260917' AND migration_name NOT LIKE '%payables_phase_1a%';

\echo '== Q3: all seven tables exist (expect 7) =='
SELECT count(*) AS payables_tables_present
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('Payee','Commitment','Installment','Payment',
                    'PaymentAllocation','PaymentEvidence','PayablesAuditEvent');

\echo '== Q4: the six new enum types exist, with their member counts =='
SELECT t.typname AS enum_type, count(e.enumlabel) AS members
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('PayeeKind','CommitmentScheduleKind','CommitmentStatus',
                    'InstallmentStatus','PaymentStatus','PaymentEvidenceKind')
GROUP BY t.typname
ORDER BY t.typname;

\echo '== Q5: PaymentMethod carries the two extended members =='
SELECT e.enumlabel AS payment_method_member
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'PaymentMethod' AND e.enumlabel IN ('DIRECT_DEBIT','STANDING_ORDER')
ORDER BY e.enumlabel;

\echo '== Q6: the allocation unique index exists AND is PARTIAL on active allocations =='
SELECT indexname,
       (indexdef LIKE '%UNIQUE%') AS is_unique,
       (indexdef LIKE '%reversedAt%IS NULL%') AS is_partial_on_active,
       indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'PaymentAllocation_active_payment_installment_key';

\echo '== Q7: RLS is enabled AND forced on all seven tables (expect 7) =='
SELECT count(*) AS tables_rls_enabled_and_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
  AND c.relname IN ('Payee','Commitment','Installment','Payment',
                    'PaymentAllocation','PaymentEvidence','PayablesAuditEvent');

\echo '== Q8: the tenant policy exists on all seven tables (expect 7) =='
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND policyname = 'payables_p1a_tenant'
ORDER BY tablename;

\echo '== Q9: backfill coverage — every obligation became exactly one commitment =='
SELECT (SELECT count(*) FROM "BusinessObligation")                              AS legacy_obligations,
       (SELECT count(*) FROM "Commitment" WHERE "legacyObligationId" IS NOT NULL) AS migrated_commitments,
       (SELECT count(DISTINCT "legacyObligationId") FROM "Commitment"
         WHERE "legacyObligationId" IS NOT NULL)                                AS distinct_sources,
       (SELECT count(*) FROM "Installment" i
         JOIN "Commitment" c ON c."id" = i."commitmentId"
        WHERE c."legacyObligationId" IS NOT NULL)                               AS migrated_installments;

\echo '== Q10: legacy MET produced ZERO synthetic Payments and ZERO synthetic allocations =='
SELECT (SELECT count(*) FROM "Payment")            AS payments_total,
       (SELECT count(*) FROM "PaymentAllocation")  AS allocations_total,
       (SELECT count(*) FROM "Installment" WHERE "status" = 'SETTLED_LEGACY') AS settled_legacy_installments,
       (SELECT count(*) FROM "Installment"
         WHERE "status" = 'SETTLED_LEGACY' AND "legacySettlementAssertedBy" IS NOT NULL) AS with_preserved_provenance;

\echo '== Q11: legacy BusinessObligation is intact — counts by state, no rows removed or emptied =='
SELECT "state", count(*) AS rows
FROM "BusinessObligation"
GROUP BY "state"
ORDER BY "state";

\echo '== Q12: no Payee entity was guessed, and no payee link was invented =='
SELECT (SELECT count(*) FROM "Payee")                                          AS payees_total,
       (SELECT count(*) FROM "Commitment" WHERE "payeeId" IS NOT NULL)          AS commitments_with_payee_link,
       (SELECT count(*) FROM "Commitment"
         WHERE "legacyObligationId" IS NOT NULL AND "payeeNameSnapshot" IS NOT NULL) AS with_tier1_snapshot;

\echo '== Q13: the migration recorded its own provenance, asserting no payment was synthesized =='
SELECT count(*) AS provenance_events,
       count(*) FILTER (WHERE "metadata" ->> 'synthesizedPayment' = 'false') AS assert_no_synthetic_payment
FROM "PayablesAuditEvent"
WHERE "eventType" = 'COMMITMENT_MIGRATED_FROM_OBLIGATION';

ROLLBACK;
