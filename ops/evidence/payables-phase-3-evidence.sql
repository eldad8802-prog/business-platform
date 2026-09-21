-- Accounts Payable Phase 3 · Production proof of the cheque / bank-account migration.
--
-- Same containment contract as the Phase 2 proof: PART 1 reads, PART 2 writes
-- inside ONE transaction that ends in ROLLBACK, touching only rows it creates
-- itself under synthetic tenants, and PART 3 proves nothing survived.
--
-- The behavioural half exists because the claims worth making here are all
-- REFUSALS, and a refusal cannot be observed by reading a catalogue. Reading
-- `pg_indexes` proves an index with the right definition exists — a statement
-- about text. Whether it bites is a different question, and the only way to
-- answer it is to ask it to bite.

SET statement_timeout = '60s';

\echo '========== PART 1 — READ-ONLY STRUCTURAL EVIDENCE =========='

\echo '== Q0: which database is answering =='
SELECT current_database() AS database, version() AS server_version;

\echo '== Q1: the Phase 3 migration is finished and not rolled back =='
SELECT migration_name,
       (finished_at IS NOT NULL)      AS finished,
       (rolled_back_at IS NOT NULL)   AS was_rolled_back,
       applied_steps_count
FROM _prisma_migrations
WHERE migration_name = '20260918120000_payables_phase_3_cheques_and_bank_accounts';

\echo '== Q2: nothing else arrived with it =='
SELECT count(*) AS other_migrations_after_phase2
FROM _prisma_migrations
WHERE migration_name > '20260918090000_payables_phase_2_document_evidence'
  AND migration_name <> '20260918120000_payables_phase_3_cheques_and_bank_accounts';

\echo '== Q3: both tables exist =='
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('BusinessBankAccount','Cheque')
ORDER BY table_name;

\echo '== Q4: BusinessBankAccount columns match the contract =='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'BusinessBankAccount'
ORDER BY column_name;

\echo '== Q5: NO plaintext bank coordinate column exists (must return 0) =='
SELECT count(*) AS plaintext_coordinate_columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('BusinessBankAccount','Cheque')
  AND lower(column_name) IN ('accountnumber','bankcode','branchcode','iban','swift','bic');

\echo '== Q6: the coordinates exist ONLY as ciphertext + last4 + keyed fingerprint =='
SELECT
  bool_or(column_name = 'coordinatesEncrypted') AS has_ciphertext,
  bool_or(column_name = 'coordinatesIv')        AS has_iv,
  bool_or(column_name = 'coordinatesTag')       AS has_tag,
  bool_or(column_name = 'encryptionKeyId')      AS has_key_id,
  bool_or(column_name = 'accountLast4')         AS has_last4,
  bool_or(column_name = 'fingerprint')          AS has_fingerprint
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'BusinessBankAccount';

\echo '== Q7: Cheque columns match the contract =='
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Cheque'
ORDER BY column_name;

\echo '== Q8: chequeNumber is TEXT — no sequential/numeric assumption is possible =='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Cheque' AND column_name = 'chequeNumber';

\echo '== Q9: the enums exist with exactly the intended values =='
SELECT t.typname AS enum_type, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS values
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('ChequeStatus','ChequeClearedSource')
GROUP BY t.typname ORDER BY t.typname;

\echo '== Q10: ChequeClearedSource has ONLY owner assertion — no bank verification is representable =='
SELECT count(*) AS cleared_source_values,
       bool_and(e.enumlabel = 'OWNER_ASSERTED') AS only_owner_asserted
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'ChequeClearedSource';

\echo '== Q11: the foreign keys match the design =='
SELECT tc.constraint_name, kcu.column_name AS from_column,
       ccu.table_name AS to_table, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('BusinessBankAccount','Cheque')
ORDER BY tc.table_name, tc.constraint_name;

\echo '== Q12: the indexes exist, and the partial ones are genuinely partial =='
SELECT indexname,
       (indexdef LIKE '%UNIQUE%')                AS is_unique,
       (indexdef LIKE '%WHERE%')                 AS is_partial,
       indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('BusinessBankAccount_businessId_fingerprint_key',
                    'BusinessBankAccount_one_active_default',
                    'Cheque_active_number_key',
                    'Cheque_replaces_key')
ORDER BY indexname;

\echo '== Q13: RLS enabled AND forced on both new tables, with their policies =='
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
           AND c.relname IN ('BusinessBankAccount','Cheque'))            AS p3_tables_forced,
       (SELECT count(*) FROM pg_policies WHERE policyname='payables_p3_tenant') AS p3_policies;

\echo '== Q14: Phase 1a/2 isolation is untouched =='
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
           AND c.relname IN ('Payee','Commitment','Installment','Payment',
                             'PaymentAllocation','PaymentEvidence','PayablesAuditEvent')) AS p1a_forced,
       (SELECT count(*) FROM pg_policies WHERE policyname='payables_p1a_tenant')           AS p1a_policies,
       (SELECT count(*) FROM pg_policies WHERE policyname='payables_p2_tenant')            AS p2_policies;

\echo '== Q15: the migration created NOTHING in Production data =='
SELECT (SELECT count(*) FROM "BusinessBankAccount")     AS bank_accounts,
       (SELECT count(*) FROM "Cheque")                  AS cheques,
       (SELECT count(*) FROM "Payment")                 AS payments,
       (SELECT count(*) FROM "PaymentAllocation")       AS allocations,
       (SELECT count(*) FROM "PaymentEvidence")         AS evidence,
       (SELECT count(*) FROM "PayablesMatchRejection")  AS rejections;
-- Payment / allocation / evidence counts are REAL owner data since Phase 1b/2
-- went live, so a non-zero value here is not a migration side effect. They are
-- captured only as the baseline P9 compares against after the rollback.
SELECT (SELECT count(*) FROM "Payment")           AS q15_payments,
       (SELECT count(*) FROM "PaymentAllocation") AS q15_allocations,
       (SELECT count(*) FROM "PaymentEvidence")   AS q15_evidence
\gset

\echo '== Q16: Phase 1a/1b data survived =='
SELECT (SELECT count(*) FROM "BusinessObligation")                                AS legacy_obligations,
       (SELECT count(*) FROM "Commitment" WHERE "legacyObligationId" IS NOT NULL) AS migrated_commitments,
       (SELECT count(*) FROM "Installment")                                       AS installments;

\echo '== Q17: the structural claims above, ASSERTED (a printed table cannot fail a step) =='
DO $proof$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _prisma_migrations
   WHERE migration_name = '20260918120000_payables_phase_3_cheques_and_bank_accounts'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF structural: migration not finished exactly once (%)', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('BusinessBankAccount','Cheque')
     AND lower(column_name) IN ('accountnumber','bankcode','branchcode','iban','swift','bic');
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % plaintext coordinate column(s) exist', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Cheque'
     AND column_name = 'chequeNumber' AND data_type = 'text';
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF structural: chequeNumber is not TEXT'; END IF;

  SELECT count(*) INTO n FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typname = 'ChequeClearedSource' AND e.enumlabel <> 'OWNER_ASSERTED';
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: ChequeClearedSource has a non-owner value'; END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
     AND c.relname IN ('BusinessBankAccount','Cheque');
  IF n <> 2 THEN RAISE EXCEPTION 'PROOF structural: RLS enabled+forced on % of 2 tables', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE policyname = 'payables_p3_tenant' AND tablename IN ('BusinessBankAccount','Cheque');
  IF n <> 2 THEN RAISE EXCEPTION 'PROOF structural: % of 2 payables_p3_tenant policies', n; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%'
     AND indexname IN ('BusinessBankAccount_one_active_default','Cheque_active_number_key','Cheque_replaces_key');
  IF n <> 3 THEN RAISE EXCEPTION 'PROOF structural: % of 3 partial unique indexes', n; END IF;

  -- No application code can write these tables yet, so any row here is not
  -- ours and not the migration's to have made.
  SELECT count(*) INTO n FROM "BusinessBankAccount";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % bank account(s) exist before any code can write one', n; END IF;
  SELECT count(*) INTO n FROM "Cheque";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % cheque(s) exist before any code can write one', n; END IF;

  RAISE NOTICE 'PROOF structural: PASS';
END
$proof$;

\echo '========== PART 2 — BEHAVIOURAL PROOF (synthetic, rolled back) =========='

BEGIN;

-- TWO synthetic tenants. The second one exists specifically to prove the
-- cross-tenant property below.
INSERT INTO "Business" ("name","updatedAt") VALUES ('__dubiz_p3_proof_rollback_only__A', NOW());
INSERT INTO "Business" ("name","updatedAt") VALUES ('__dubiz_p3_proof_rollback_only__B', NOW());

INSERT INTO "BusinessBankAccount"
  ("businessId","label","coordinatesEncrypted","coordinatesIv","coordinatesTag",
   "encryptionKeyId","accountLast4","fingerprint","isDefault","updatedAt")
SELECT id,'primary','ct','iv','tag','payables-bank-v1','8901','fp-shared-canonical',true,NOW()
FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__A';

\echo '== P1: the SAME canonical fingerprint in a DIFFERENT tenant does NOT collide =='
-- This is the index-semantics claim, not the HMAC claim. The fingerprint string
-- inserted here is BYTE-IDENTICAL to tenant A's. If the unique index were
-- global rather than (businessId, fingerprint), this insert would fail — and
-- two businesses banking at the same account could never coexist. Proving it
-- with an identical string is deliberately stronger than relying on the HMAC
-- being tenant-bound, because it holds even if the crypto were wrong.
DO $proof$
DECLARE ok boolean := false;
BEGIN
  INSERT INTO "BusinessBankAccount"
    ("businessId","label","coordinatesEncrypted","coordinatesIv","coordinatesTag",
     "encryptionKeyId","accountLast4","fingerprint","updatedAt")
  SELECT id,'primary','ct','iv','tag','payables-bank-v1','8901','fp-shared-canonical',NOW()
  FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__B';
  ok := true;
  IF ok THEN
    RAISE NOTICE 'PROOF cross-tenant-fingerprint: ALLOWED — the same canonical account can exist in two tenants';
  END IF;
END
$proof$;

\echo '== P2: a duplicate fingerprint WITHIN one tenant is refused =='
DO $proof$
DECLARE refused boolean := false; bid int;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__A';
  BEGIN
    INSERT INTO "BusinessBankAccount"
      ("businessId","label","coordinatesEncrypted","coordinatesIv","coordinatesTag",
       "encryptionKeyId","accountLast4","fingerprint","updatedAt")
    VALUES (bid,'duplicate','ct','iv','tag','payables-bank-v1','8901','fp-shared-canonical',NOW());
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF refused THEN RAISE NOTICE 'PROOF duplicate-fingerprint-same-tenant: REFUSED';
  ELSE RAISE EXCEPTION 'PROOF duplicate-fingerprint-same-tenant: ACCEPTED — the guard is not working';
  END IF;
END
$proof$;

\echo '== P3: only one ACTIVE default account per tenant =='
DO $proof$
DECLARE refused boolean := false; bid int;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__A';
  BEGIN
    INSERT INTO "BusinessBankAccount"
      ("businessId","label","coordinatesEncrypted","coordinatesIv","coordinatesTag",
       "encryptionKeyId","accountLast4","fingerprint","isDefault","updatedAt")
    VALUES (bid,'second default','ct','iv','tag','payables-bank-v1','7777','fp-other',true,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF refused THEN RAISE NOTICE 'PROOF second-active-default: REFUSED';
  ELSE RAISE EXCEPTION 'PROOF second-active-default: ACCEPTED — the invariant is not held';
  END IF;
END
$proof$;

\echo '== P4/P5/P6: cheque number, reuse after cancellation, replacement chain =='
DO $proof$
DECLARE
  bid int; acc int; first_id int;
  refused boolean := false;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__A';
  SELECT min(id) INTO acc FROM "BusinessBankAccount" WHERE "businessId" = bid;

  -- Non-sequential on purpose: nothing infers the next number from these.
  INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                        "issueDate","dueDate","sourceBankAccountId","updatedAt")
  VALUES (bid,'proof payee',1000,'500105',NOW(),NOW(),acc,NOW())
  RETURNING id INTO first_id;

  INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                        "issueDate","dueDate","sourceBankAccountId","updatedAt")
  VALUES (bid,'proof payee',1000,'A-7788/ג',NOW(),NOW(),acc,NOW());
  RAISE NOTICE 'PROOF non-sequential-numbers: ACCEPTED — 500105 and A-7788/ג coexist, no arithmetic is implied';

  BEGIN
    INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                          "issueDate","dueDate","sourceBankAccountId","updatedAt")
    VALUES (bid,'proof payee',1000,'500105',NOW(),NOW(),acc,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF refused THEN RAISE NOTICE 'PROOF duplicate-live-cheque-number: REFUSED';
  ELSE RAISE EXCEPTION 'PROOF duplicate-live-cheque-number: ACCEPTED — the guard is not working';
  END IF;

  -- Cancel, then the SAME number may be recorded again. This is the partial
  -- predicate (WHERE "cancelledAt" IS NULL) being asked to let go, not assumed.
  UPDATE "Cheque" SET "cancelledAt" = NOW(), "status" = 'CANCELLED' WHERE id = first_id;
  INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                        "issueDate","dueDate","sourceBankAccountId","updatedAt")
  VALUES (bid,'proof payee',1000,'500105',NOW(),NOW(),acc,NOW());
  RAISE NOTICE 'PROOF cancelled-number-reusable: ALLOWED — #500105 recorded again after its cancellation';

  INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                        "issueDate","dueDate","sourceBankAccountId","replacesChequeId","updatedAt")
  VALUES (bid,'proof payee',1000,'500220',NOW(),NOW(),acc,first_id,NOW());
  RAISE NOTICE 'PROOF cancel-then-replace: ALLOWED — #500105 CANCELLED, replacement #500220 links to it';

  refused := false;
  BEGIN
    INSERT INTO "Cheque" ("businessId","payeeNameSnapshot","amount","chequeNumber",
                          "issueDate","dueDate","sourceBankAccountId","replacesChequeId","updatedAt")
    VALUES (bid,'proof payee',1000,'500221',NOW(),NOW(),acc,first_id,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF refused THEN RAISE NOTICE 'PROOF replacement-chain-fork: REFUSED';
  ELSE RAISE EXCEPTION 'PROOF replacement-chain-fork: ACCEPTED — two cheques claim one predecessor';
  END IF;
END
$proof$;

\echo '== P7: CLEARED can only be owner-asserted =='
DO $proof$
DECLARE bid int; cid int; refused boolean := false;
BEGIN
  SELECT id INTO bid FROM "Business" WHERE "name" = '__dubiz_p3_proof_rollback_only__A';
  -- A LIVE cheque: asserting that a cancelled one cleared would prove nothing.
  SELECT id INTO cid FROM "Cheque" WHERE "businessId" = bid AND "chequeNumber" = 'A-7788/ג';

  UPDATE "Cheque"
     SET "status" = 'CLEARED', "clearedAssertedAt" = NOW(), "clearedSource" = 'OWNER_ASSERTED'
   WHERE id = cid;
  RAISE NOTICE 'PROOF cleared-owner-asserted: RECORDED as OWNER_ASSERTED';

  -- There is no bank feed, so no other provenance is even representable.
  BEGIN
    UPDATE "Cheque" SET "clearedSource" = 'BANK_VERIFIED' WHERE id = cid;
  EXCEPTION WHEN invalid_text_representation OR undefined_object THEN refused := true;
  END;
  IF refused THEN
    RAISE NOTICE 'PROOF cleared-not-bank-verified: REFUSED — bank verification is not representable';
  ELSE
    RAISE EXCEPTION 'PROOF cleared-not-bank-verified: a bank-verified provenance was accepted';
  END IF;
END
$proof$;

ROLLBACK;

\echo '== P8: nothing survived the rollback (every count must be 0) =='
-- Exact match, not LIKE: in a LIKE pattern the leading `__` are single-character
-- WILDCARDS, not literal underscores, so a LIKE here would be quietly matching
-- something broader than the marker it appears to name.
SELECT (SELECT count(*) FROM "Business"
         WHERE "name" IN ('__dubiz_p3_proof_rollback_only__A',
                          '__dubiz_p3_proof_rollback_only__B'))                                AS synthetic_businesses,
       (SELECT count(*) FROM "BusinessBankAccount")                                            AS bank_accounts_total,
       (SELECT count(*) FROM "Cheque")                                                         AS cheques_total;

\echo '== P9: the real totals are unchanged from Q15 =='
SELECT (SELECT count(*) FROM "Payment")            AS payments_total,
       (SELECT count(*) FROM "PaymentAllocation")  AS allocations_total,
       (SELECT count(*) FROM "PaymentEvidence")    AS evidence_total;

\echo '== P8/P9 ASSERTED: a survivor or a changed real total fails the run =='
DO $proof$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Business"
   WHERE "name" IN ('__dubiz_p3_proof_rollback_only__A','__dubiz_p3_proof_rollback_only__B');
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF zero-survivors: % synthetic business(es) survived', n; END IF;
  -- Q17 asserted both tables were empty before the transaction, so any row now is a survivor.
  SELECT count(*) INTO n FROM "BusinessBankAccount";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF zero-survivors: % bank account(s) survived', n; END IF;
  SELECT count(*) INTO n FROM "Cheque";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF zero-survivors: % cheque(s) survived', n; END IF;
  RAISE NOTICE 'PROOF zero-survivors: CONFIRMED';
END
$proof$;

-- psql variables do not interpolate inside a dollar-quoted DO body, so the
-- comparison with the Q15 baseline is made here and branched on with \if.
-- (A real owner recording a payment in the seconds between Q15 and here would
-- fail this closed, never open; re-dispatch in that case.)
SELECT ((SELECT count(*) FROM "Payment")           = :q15_payments
    AND (SELECT count(*) FROM "PaymentAllocation") = :q15_allocations
    AND (SELECT count(*) FROM "PaymentEvidence")   = :q15_evidence) AS p9_ok
\gset
\if :p9_ok
  \echo 'PROOF real-totals-unchanged: CONFIRMED'
\else
  DO $proof$ BEGIN RAISE EXCEPTION 'PROOF real-totals-unchanged: a real Payment/allocation/evidence total moved'; END $proof$;
\endif
