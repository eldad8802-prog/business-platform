-- Accounts Payable Phase 2 · Production proof of the document-evidence migration.
--
-- Two halves, and the second one writes. That is unusual here and is the reason
-- this file does not live under the SELECT-only evidence workflow.
--
-- ── Why a write is unavoidable ──────────────────────────────────────────────
--
-- The claim being tested is that the database REFUSES a second active document
-- evidence row. A refusal cannot be observed by reading a catalogue: reading
-- `pg_indexes` proves an index with the right definition exists, which is a
-- claim about text, not about behaviour. The only way to prove the guard
-- actually bites is to ask it to bite.
--
-- ── How the write is contained ──────────────────────────────────────────────
--
-- 1. ONE transaction, and it ends in ROLLBACK. There is no COMMIT in this file
--    and the CI step greps to prove it.
-- 2. Every row is created BY THIS SCRIPT under a synthetic business whose name
--    carries an unmistakable marker. No pre-existing row is read into a write,
--    updated, or deleted — the only UPDATE targets a row inserted moments
--    earlier inside this same transaction.
-- 3. psql runs with ON_ERROR_STOP, so any unexpected error aborts the session
--    and Postgres rolls the transaction back on disconnect.
-- 4. After the ROLLBACK the script asks the database whether anything survived,
--    and the CI step fails if the answer is not zero.
--
-- Net effect on Production: nothing durable. WAL churn and a few short-lived
-- locks on rows that never existed outside the transaction.

SET statement_timeout = '60s';

\echo '========== PART 1 — READ-ONLY STRUCTURAL EVIDENCE =========='

\echo '== Q0: which database is answering =='
SELECT current_database() AS database, version() AS server_version;

\echo '== Q1: the Phase 2 migration is finished and not rolled back =='
SELECT migration_name,
       (finished_at IS NOT NULL) AS finished,
       (rolled_back_at IS NOT NULL) AS was_rolled_back,
       applied_steps_count
FROM _prisma_migrations
WHERE migration_name = '20260918090000_payables_phase_2_document_evidence';

\echo '== Q2: nothing else was applied alongside it =='
SELECT count(*) AS other_migrations_since_20260918
FROM _prisma_migrations
WHERE migration_name > '20260917999999'
  AND migration_name <> '20260918090000_payables_phase_2_document_evidence';

\echo '== Q3: the new PaymentEvidence columns exist, with the right types =='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'PaymentEvidence'
  AND column_name IN ('documentId','financialRecordId','revokedAt','revokedByUserId','revocationReason')
ORDER BY column_name;

\echo '== Q4: the FK to Document matches the design (SET NULL on delete) =='
SELECT tc.constraint_name,
       kcu.column_name    AS from_column,
       ccu.table_name     AS to_table,
       ccu.column_name    AS to_column,
       rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'PaymentEvidence'
  AND tc.constraint_name = 'PaymentEvidence_documentId_fkey';

\echo '== Q5: the double-count index exists AND is genuinely PARTIAL =='
SELECT indexname,
       (indexdef LIKE '%UNIQUE%')                  AS is_unique,
       (indexdef LIKE '%revokedAt%IS NULL%')       AS partial_on_active,
       (indexdef LIKE '%documentId%IS NOT NULL%')  AS partial_on_document,
       indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'PaymentEvidence_active_document_key';

\echo '== Q6: PayablesMatchRejection exists with RLS enabled AND forced =='
SELECT c.relname,
       c.relrowsecurity      AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'PayablesMatchRejection';

\echo '== Q7: its tenant policy is present =='
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND policyname = 'payables_p2_tenant';

\echo '== Q8: Phase 1a tenant isolation is untouched — still 7 forced tables, 7 policies =='
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
           AND c.relname IN ('Payee','Commitment','Installment','Payment',
                             'PaymentAllocation','PaymentEvidence','PayablesAuditEvent')) AS p1a_tables_forced,
       (SELECT count(*) FROM pg_policies
         WHERE schemaname='public' AND policyname='payables_p1a_tenant')                   AS p1a_policies;

\echo '== Q9: the migration created NO payments and NO allocations =='
SELECT (SELECT count(*) FROM "Payment")            AS payments_total,
       (SELECT count(*) FROM "PaymentAllocation")  AS allocations_total,
       (SELECT count(*) FROM "PaymentEvidence")    AS evidence_total,
       (SELECT count(*) FROM "PayablesMatchRejection") AS rejections_total;

\echo '== Q10: Phase 1a data survived — same shape as the Phase 1a proof =='
SELECT (SELECT count(*) FROM "BusinessObligation")                                AS legacy_obligations,
       (SELECT count(*) FROM "Commitment" WHERE "legacyObligationId" IS NOT NULL) AS migrated_commitments,
       (SELECT count(*) FROM "Installment")                                       AS installments_total,
       (SELECT count(*) FROM "Payee")                                             AS payees_total;

\echo '========== PART 2 — BEHAVIOURAL PROOF (synthetic, rolled back) =========='

BEGIN;

-- A tenant that exists only inside this transaction.
INSERT INTO "Business" ("name", "updatedAt") VALUES ('__dubiz_p2_proof_rollback_only__', NOW());

INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status")
SELECT id, 'proof://phase2', 'proof', 'application/pdf', 'APPROVED'
FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__';

INSERT INTO "Payment" ("businessId","payeeNameSnapshot","amount","currency","paidAt","method","status","updatedAt")
SELECT id, 'proof payee', 1, 'ILS', NOW(), 'CASH', 'RECORDED', NOW()
FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__';

INSERT INTO "Payment" ("businessId","payeeNameSnapshot","amount","currency","paidAt","method","status","updatedAt")
SELECT id, 'proof payee 2', 1, 'ILS', NOW(), 'CASH', 'RECORDED', NOW()
FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__';

-- First attachment: must succeed.
INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","documentId")
SELECT b.id, (SELECT min(id) FROM "Payment" p WHERE p."businessId" = b.id), 'DOCUMENT',
       (SELECT min(id) FROM "Document" d WHERE d."businessId" = b.id)
FROM "Business" b WHERE b."name" = '__dubiz_p2_proof_rollback_only__';

\echo '== P1: a SECOND active evidence row for the same (businessId, documentId) =='
DO $proof$
DECLARE
  refused boolean := false;
  bid int;
  did int;
  pid2 int;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__';
  SELECT min(id) INTO did FROM "Document" WHERE "businessId" = bid;
  SELECT max(id) INTO pid2 FROM "Payment" WHERE "businessId" = bid;
  BEGIN
    INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","documentId")
    VALUES (bid, pid2, 'DOCUMENT', did);
  EXCEPTION WHEN unique_violation THEN
    refused := true;
  END;
  IF refused THEN
    RAISE NOTICE 'PROOF duplicate-active: REFUSED — the guard bites';
  ELSE
    RAISE EXCEPTION 'PROOF duplicate-active: ACCEPTED — the double-count guard is NOT working';
  END IF;
END
$proof$;

\echo '== P2: after revoking, the same document may be associated again =='
DO $proof$
DECLARE
  bid int;
  did int;
  pid2 int;
  reattached int;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__';
  SELECT min(id) INTO did FROM "Document" WHERE "businessId" = bid;
  SELECT max(id) INTO pid2 FROM "Payment" WHERE "businessId" = bid;

  UPDATE "PaymentEvidence"
     SET "revokedAt" = NOW(), "revocationReason" = 'proof'
   WHERE "businessId" = bid AND "documentId" = did AND "revokedAt" IS NULL;

  INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","documentId")
  VALUES (bid, pid2, 'DOCUMENT', did);

  SELECT count(*) INTO reattached
  FROM "PaymentEvidence" WHERE "businessId" = bid AND "documentId" = did AND "revokedAt" IS NULL;

  IF reattached = 1 THEN
    RAISE NOTICE 'PROOF revoke-then-reassociate: ALLOWED — reconciliation is not a one-way door';
  ELSE
    RAISE EXCEPTION 'PROOF revoke-then-reassociate: expected exactly 1 active row, found %', reattached;
  END IF;
END
$proof$;

ROLLBACK;

\echo '== P3: nothing survived the rollback (every count must be 0) =='
SELECT (SELECT count(*) FROM "Business" WHERE "name" = '__dubiz_p2_proof_rollback_only__') AS synthetic_businesses,
       (SELECT count(*) FROM "Document" WHERE "fileUrl" = 'proof://phase2')                AS synthetic_documents,
       (SELECT count(*) FROM "Payment" WHERE "payeeNameSnapshot" LIKE 'proof payee%')      AS synthetic_payments;

\echo '== P4: the real totals are unchanged from Q9 =='
SELECT (SELECT count(*) FROM "Payment")            AS payments_total,
       (SELECT count(*) FROM "PaymentAllocation")  AS allocations_total,
       (SELECT count(*) FROM "PaymentEvidence")    AS evidence_total;
