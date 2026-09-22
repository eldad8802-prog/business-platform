-- Accounts Payable Phases 4–6 · proof of 20260922130000_payables_p4_p6_outbound_foundation.
--
-- Same containment contract as the Phase 3 proof. PART 1 reads and ASSERTS the
-- structure. PART 2 writes inside ONE transaction that ends in ROLLBACK, touching
-- only rows it creates under two synthetic tenants. PART 3 asserts nothing
-- survived and that real totals did not move.
--
-- Every claim RAISEs on failure under ON_ERROR_STOP, so a claim line can only be
-- printed if the property held. The workflow then requires every named claim.
--
-- The same file is the migration PR's CI rehearsal on an ephemeral PG17 and the
-- Production proof after release-migrate.

SET statement_timeout = '60s';

\echo '========== PART 1 — STRUCTURE (asserted) =========='

DO $proof$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _prisma_migrations
   WHERE migration_name = '20260922130000_payables_p4_p6_outbound_foundation'
     AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF structural: migration not finished exactly once (%)', n; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('PaymentDestination','PaymentPreparation','ExternalTransaction',
                        'ExternalTransactionMatchRejection','OutboundExecution');
  IF n <> 5 THEN RAISE EXCEPTION 'PROOF structural: % of 5 tables', n; END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
     AND c.relname IN ('PaymentDestination','PaymentPreparation','ExternalTransaction',
                       'ExternalTransactionMatchRejection','OutboundExecution');
  IF n <> 5 THEN RAISE EXCEPTION 'PROOF structural: RLS enabled+forced on % of 5', n; END IF;

  SELECT count(*) INTO n FROM pg_policies WHERE policyname = 'payables_p46_tenant';
  IF n <> 5 THEN RAISE EXCEPTION 'PROOF structural: % of 5 tenant policies', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('PaymentDestination','OutboundExecution','PaymentPreparation')
     AND lower(column_name) IN ('accountnumber','bankcode','branchcode','iban','swift','bic');
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % plaintext coordinate column(s)', n; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'PaymentEvidence' AND column_name = 'externalTransactionId';
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF structural: PaymentEvidence.externalTransactionId missing'; END IF;

  SELECT count(*) INTO n FROM pg_constraint WHERE conname IN (
    'PaymentDestination_verification_none_check',
    'PaymentPreparation_amount_positive_check',
    'PaymentPreparation_approved_snapshot_check',
    'PaymentPreparation_completed_payment_check',
    'ExternalTransaction_amount_positive_check',
    'OutboundExecution_amount_positive_check',
    'OutboundExecution_payment_only_when_settled_check');
  IF n <> 7 THEN RAISE EXCEPTION 'PROOF structural: % of 7 CHECK constraints', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'ExternalTransaction_facts_immutable' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF structural: immutability trigger missing'; END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%'
     AND indexname IN ('PaymentDestination_one_active_default','PaymentDestination_replaces_key',
                       'PaymentPreparation_paymentId_key','PaymentEvidence_active_external_transaction_key',
                       'OutboundExecution_provider_reference_key','OutboundExecution_one_live_per_preparation',
                       'OutboundExecution_one_settled_per_preparation','OutboundExecution_paymentId_key');
  IF n <> 8 THEN RAISE EXCEPTION 'PROOF structural: % of 8 partial unique indexes', n; END IF;

  SELECT count(*) INTO n FROM "PaymentDestination";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % destination row(s) before any code can write one', n; END IF;
  SELECT count(*) INTO n FROM "PaymentPreparation";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % preparation row(s) before any code', n; END IF;
  SELECT count(*) INTO n FROM "ExternalTransaction";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % external transaction row(s) before any code', n; END IF;
  SELECT count(*) INTO n FROM "OutboundExecution";
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF structural: % execution row(s) before any code', n; END IF;

  RAISE NOTICE 'PROOF structural: PASS';
END
$proof$;

-- Real totals, captured before the transaction, compared after the rollback.
SELECT (SELECT count(*) FROM "Payment")           AS q_payments,
       (SELECT count(*) FROM "PaymentAllocation") AS q_allocations,
       (SELECT count(*) FROM "PaymentEvidence")   AS q_evidence
\gset

\echo '========== PART 2 — BEHAVIOUR (synthetic, rolled back) =========='

BEGIN;

INSERT INTO "Business" ("name","updatedAt") VALUES ('__dubiz_p46_proof_rollback_only__A', NOW());
INSERT INTO "Business" ("name","updatedAt") VALUES ('__dubiz_p46_proof_rollback_only__B', NOW());

DO $proof$
DECLARE
  a int; b int; pa int; pb int; pbb int; c int; i int; pay int; pay2 int;
  d1 int; prep int; x int; xb int; ev int;
  refused boolean;
BEGIN
  SELECT id INTO a FROM "Business" WHERE "name" = '__dubiz_p46_proof_rollback_only__A';
  SELECT id INTO b FROM "Business" WHERE "name" = '__dubiz_p46_proof_rollback_only__B';

  INSERT INTO "Payee" ("businessId","displayName","updatedAt") VALUES (a,'proof payee 1',NOW()) RETURNING id INTO pa;
  INSERT INTO "Payee" ("businessId","displayName","updatedAt") VALUES (a,'proof payee 2',NOW()) RETURNING id INTO pb;
  INSERT INTO "Payee" ("businessId","displayName","updatedAt") VALUES (b,'proof payee B',NOW()) RETURNING id INTO pbb;

  -- ── destinations ─────────────────────────────────────────────────────────
  INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
     "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","isDefault","updatedAt")
  VALUES (a,pa,'main','proof','ct','iv','tag','payables-bank-v1','3456','fp-dest',true,NOW()) RETURNING id INTO d1;

  INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
     "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","updatedAt")
  VALUES (a,pb,'shared','proof','ct','iv','tag','payables-bank-v1','3456','fp-dest',NOW());
  RAISE NOTICE 'PROOF destination-shared-by-two-payees: ALLOWED';

  refused := false;
  BEGIN
    INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
       "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","updatedAt")
    VALUES (a,pa,'dup','proof','ct','iv','tag','payables-bank-v1','3456','fp-dest',NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF destination-duplicate-same-payee: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF destination-duplicate-same-payee: REFUSED';

  refused := false;
  BEGIN
    INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
       "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","isDefault","updatedAt")
    VALUES (a,pa,'second default','proof','ct','iv','tag','payables-bank-v1','7777','fp-other',true,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF destination-second-default: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF destination-second-default: REFUSED';

  refused := false;
  BEGIN
    INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
       "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","verification","updatedAt")
    VALUES (a,pa,'claimed','proof','ct','iv','tag','payables-bank-v1','1111','fp-claimed','BANK_CONFIRMED',NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF destination-verification-claim: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF destination-verification-claim: REFUSED — nothing verifies a destination yet';

  INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
     "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","replacesDestinationId","updatedAt")
  VALUES (a,pa,'replacement','proof','ct','iv','tag','payables-bank-v1','2222','fp-r1',d1,NOW());
  refused := false;
  BEGIN
    INSERT INTO "PaymentDestination" ("businessId","payeeId","label","beneficiaryName","coordinatesEncrypted",
       "coordinatesIv","coordinatesTag","encryptionKeyId","accountLast4","fingerprint","replacesDestinationId","updatedAt")
    VALUES (a,pa,'fork','proof','ct','iv','tag','payables-bank-v1','3333','fp-r2',d1,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF destination-replacement-fork: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF destination-replacement-fork: REFUSED';

  -- ── preparations ─────────────────────────────────────────────────────────
  INSERT INTO "Commitment" ("businessId","title","payeeNameSnapshot","scheduleKind","updatedAt")
  VALUES (a,'proof commitment','proof payee 1','ONE_OFF',NOW()) RETURNING id INTO c;
  INSERT INTO "Installment" ("businessId","commitmentId","sequence","scheduledAmount","dueAt","updatedAt")
  VALUES (a,c,1,100,NOW(),NOW()) RETURNING id INTO i;
  INSERT INTO "Payment" ("businessId","payeeNameSnapshot","amount","paidAt","method","updatedAt")
  VALUES (a,'proof payee 1',100,NOW(),'BANK_TRANSFER',NOW()) RETURNING id INTO pay;
  INSERT INTO "Payment" ("businessId","payeeNameSnapshot","amount","paidAt","method","updatedAt")
  VALUES (a,'proof payee 1',50,NOW(),'BANK_TRANSFER',NOW()) RETURNING id INTO pay2;

  refused := false;
  BEGIN
    INSERT INTO "PaymentPreparation" ("businessId","commitmentId","payeeNameSnapshot","amount","method","updatedAt")
    VALUES (a,c,'proof',0,'BANK_TRANSFER',NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF preparation-zero-amount: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF preparation-zero-amount: REFUSED';

  refused := false;
  BEGIN
    INSERT INTO "PaymentPreparation" ("businessId","commitmentId","payeeNameSnapshot","amount","method","status","updatedAt")
    VALUES (a,c,'proof',100,'BANK_TRANSFER','APPROVED',NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF preparation-approved-without-snapshot: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF preparation-approved-without-snapshot: REFUSED';

  refused := false;
  BEGIN
    INSERT INTO "PaymentPreparation" ("businessId","commitmentId","payeeNameSnapshot","amount","method","status",
       "approvedAt","approvalHash","updatedAt")
    VALUES (a,c,'proof',100,'BANK_TRANSFER','COMPLETED',NOW(),'h',NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF preparation-completed-without-payment: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF preparation-completed-without-payment: REFUSED — completed means a canonical Payment exists';

  INSERT INTO "PaymentPreparation" ("businessId","commitmentId","installmentId","payeeNameSnapshot","amount","method",
     "destinationId","status","approvedAt","approvalHash","completedAt","completionSource","paymentId","updatedAt")
  VALUES (a,c,i,'proof',100,'BANK_TRANSFER',d1,'COMPLETED',NOW(),'h',NOW(),'OWNER_REPORTED',pay,NOW()) RETURNING id INTO prep;
  refused := false;
  BEGIN
    INSERT INTO "PaymentPreparation" ("businessId","commitmentId","payeeNameSnapshot","amount","method","status",
       "approvedAt","approvalHash","completedAt","completionSource","paymentId","updatedAt")
    VALUES (a,c,'proof',100,'BANK_TRANSFER','COMPLETED',NOW(),'h',NOW(),'OWNER_REPORTED',pay,NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF preparation-shares-payment: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF preparation-shares-payment: REFUSED — one Payment completes one preparation';

  -- ── external transactions ────────────────────────────────────────────────
  INSERT INTO "ExternalTransaction" ("businessId","source","externalId","direction","amount","bookedAt","updatedAt")
  VALUES (a,'OWNER_UPLOAD','ext-1','DEBIT',100,NOW(),NOW()) RETURNING id INTO x;
  refused := false;
  BEGIN
    INSERT INTO "ExternalTransaction" ("businessId","source","externalId","direction","amount","bookedAt","updatedAt")
    VALUES (a,'OWNER_UPLOAD','ext-1','DEBIT',100,NOW(),NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF external-duplicate-ingest: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF external-duplicate-ingest: REFUSED — re-delivery is the same line';

  INSERT INTO "ExternalTransaction" ("businessId","source","externalId","direction","amount","bookedAt","updatedAt")
  VALUES (b,'OWNER_UPLOAD','ext-1','DEBIT',100,NOW(),NOW()) RETURNING id INTO xb;
  RAISE NOTICE 'PROOF external-same-id-other-tenant: ALLOWED';

  refused := false;
  BEGIN
    UPDATE "ExternalTransaction" SET "amount" = 99 WHERE id = x;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF external-facts-immutable: an observed amount was edited'; END IF;
  RAISE NOTICE 'PROOF external-facts-immutable: REFUSED';

  UPDATE "ExternalTransaction" SET "dismissedAt" = NOW(), "dismissReason" = 'proof', "updatedAt" = NOW() WHERE id = xb;
  RAISE NOTICE 'PROOF external-dismissal: ALLOWED — only the owner decision changes';

  INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","externalTransactionId")
  VALUES (a,pay,'BANK_TRANSACTION',x) RETURNING id INTO ev;
  refused := false;
  BEGIN
    INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","externalTransactionId")
    VALUES (a,pay2,'BANK_TRANSACTION',x);
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF external-evidences-two-payments: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF external-evidences-two-payments: REFUSED — one bank line, one Payment';

  UPDATE "PaymentEvidence" SET "revokedAt" = NOW() WHERE id = ev;
  INSERT INTO "PaymentEvidence" ("businessId","paymentId","kind","externalTransactionId")
  VALUES (a,pay2,'BANK_TRANSACTION',x);
  RAISE NOTICE 'PROOF external-reassociate-after-revoke: ALLOWED';

  -- ── outbound executions ──────────────────────────────────────────────────
  INSERT INTO "OutboundExecution" ("businessId","preparationId","provider","idempotencyKey","amount",
     "destinationFingerprint","approvalHash","updatedAt")
  VALUES (a,prep,'proof-adapter','exec-1',100,'fp-dest','h',NOW());

  refused := false;
  BEGIN
    INSERT INTO "OutboundExecution" ("businessId","preparationId","provider","idempotencyKey","amount",
       "destinationFingerprint","approvalHash","updatedAt")
    VALUES (a,prep,'proof-adapter','exec-1',100,'fp-dest','h',NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF execution-idempotency-key: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF execution-idempotency-key: REFUSED — a retry is the same request';

  refused := false;
  BEGIN
    INSERT INTO "OutboundExecution" ("businessId","preparationId","provider","idempotencyKey","amount",
       "destinationFingerprint","approvalHash","updatedAt")
    VALUES (a,prep,'proof-adapter','exec-2',100,'fp-dest','h',NOW());
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF execution-second-live-attempt: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF execution-second-live-attempt: REFUSED';

  refused := false;
  BEGIN
    INSERT INTO "OutboundExecution" ("businessId","preparationId","provider","idempotencyKey","amount",
       "destinationFingerprint","approvalHash","status","paymentId","updatedAt")
    VALUES (a,prep,'proof-adapter','exec-3',100,'fp-dest','h','FAILED',pay2,NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF execution-payment-before-settlement: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF execution-payment-before-settlement: REFUSED — acceptance is not settlement';

  refused := false;
  BEGIN
    INSERT INTO "OutboundExecution" ("businessId","preparationId","provider","idempotencyKey","amount",
       "destinationFingerprint","approvalHash","status","settledAt","updatedAt")
    VALUES (a,prep,'proof-adapter','exec-4',100,'fp-dest','h','SETTLED',NOW(),NOW());
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'PROOF execution-settled-without-payment: ACCEPTED'; END IF;
  RAISE NOTICE 'PROOF execution-settled-without-payment: REFUSED';
END
$proof$;

ROLLBACK;

\echo '========== PART 3 — NOTHING SURVIVED (asserted) =========='

DO $proof$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Business"
   WHERE "name" IN ('__dubiz_p46_proof_rollback_only__A', '__dubiz_p46_proof_rollback_only__B');
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF zero-survivors: % synthetic business(es)', n; END IF;
  SELECT (SELECT count(*) FROM "PaymentDestination") + (SELECT count(*) FROM "PaymentPreparation")
       + (SELECT count(*) FROM "ExternalTransaction") + (SELECT count(*) FROM "OutboundExecution")
       + (SELECT count(*) FROM "ExternalTransactionMatchRejection") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF zero-survivors: % row(s) in the new tables', n; END IF;
  RAISE NOTICE 'PROOF zero-survivors: CONFIRMED';
END
$proof$;

SELECT ((SELECT count(*) FROM "Payment")           = :q_payments
    AND (SELECT count(*) FROM "PaymentAllocation") = :q_allocations
    AND (SELECT count(*) FROM "PaymentEvidence")   = :q_evidence) AS totals_ok
\gset
\if :totals_ok
  \echo 'PROOF real-totals-unchanged: CONFIRMED'
\else
  DO $proof$ BEGIN RAISE EXCEPTION 'PROOF real-totals-unchanged: a real total moved'; END $proof$;
\endif
