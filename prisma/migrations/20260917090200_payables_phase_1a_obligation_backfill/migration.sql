-- Accounts Payable — Phase 1a backfill of `BusinessObligation` into the ledger.
--
-- EXPAND-ONLY and NON-DESTRUCTIVE. `BusinessObligation` is read here and left
-- exactly as it is: not dropped, not renamed, not repurposed, not emptied. It
-- keeps serving today's Secretary reminders until a later, separately approved
-- programme retires it.
--
-- ── What this migration deliberately does NOT do ────────────────────────────
--
-- 1. It does NOT synthesize a Payment for `state = 'MET'`.
--
--    The owner-facing action is "סמן שטופל" — *mark as handled* — and
--    `settlementAssertedBy` records the provenance of that ASSERTION. The
--    ratified domain document is explicit that this domain does not own payment
--    truth ("Payments owns payment attempts and verified settlement"). Creating
--    a Payment here would fabricate an economic event — an amount, a date and a
--    payee that nothing ever observed — and those fabrications would then become
--    reconciliation candidates against real receipts in Phase 2. The assertion
--    is preserved as an assertion: `SETTLED_LEGACY` plus its original
--    provenance, contributing ZERO to any paid amount.
--
-- 2. It does NOT parse `note` text. `פריסת תשלומים 1/12` does not become a
--    parent commitment, and `צ'ק מס' 500101` does not become a cheque. Those
--    rows migrate as independent commitments carrying their note verbatim.
--    Historical meaning is not invented from free text.
--
-- 3. It creates no `Payee`. Every migrated commitment keeps `payeeId` NULL and
--    carries the original `obligeeName` as its Tier-1 `payeeNameSnapshot`.
--    Resolving those strings to entities is an owner-driven act, not a
--    migration's guess.
--
-- ── Idempotency ─────────────────────────────────────────────────────────────
--
-- Re-running is a no-op: the insert is guarded by `legacyObligationId`, which is
-- unique per source row. A partial run resumes cleanly.

-- One Commitment per obligation. 1:1 — never grouped.
INSERT INTO "Commitment" (
  "businessId", "title", "payeeNameSnapshot", "currency", "totalAmount",
  "scheduleKind", "recurrence", "recurrenceSeriesId", "status", "note",
  "legacyObligationId", "createdAt", "updatedAt"
)
SELECT
  o."businessId",
  -- The legacy model has no title. The payee name is the most honest label
  -- available, and the note is preserved separately below.
  o."obligeeName",
  o."obligeeName",
  o."currency",
  -- A one-instalment commitment's total IS its single scheduled amount, which
  -- keeps the finite-plan invariant true for every migrated row.
  o."amount",
  CASE WHEN o."recurrence" = 'NONE' THEN 'ONE_OFF'::"CommitmentScheduleKind"
       ELSE 'RECURRING'::"CommitmentScheduleKind" END,
  o."recurrence",
  o."recurrenceSeriesId",
  CASE o."state"
    WHEN 'OPEN'     THEN 'ACTIVE'::"CommitmentStatus"
    WHEN 'MET'      THEN 'CLOSED'::"CommitmentStatus"
    WHEN 'RELEASED' THEN 'RELEASED'::"CommitmentStatus"
    ELSE 'ACTIVE'::"CommitmentStatus"
  END,
  o."note",
  o."id",
  o."createdAt",
  o."updatedAt"
FROM "BusinessObligation" o
WHERE NOT EXISTS (
  SELECT 1 FROM "Commitment" c
  WHERE c."legacyObligationId" = o."id" AND c."businessId" = o."businessId"
);

-- Exactly one Installment per migrated commitment.
INSERT INTO "Installment" (
  "businessId", "commitmentId", "sequence", "scheduledAmount", "currency",
  "dueAt", "status", "legacySettlementAssertedBy", "legacyMetAt",
  "createdAt", "updatedAt"
)
SELECT
  c."businessId",
  c."id",
  1,
  o."amount",
  o."currency",
  o."dueAt",
  CASE o."state"
    -- The whole point of this migration. A pre-ledger "handled" assertion is
    -- recorded AS an assertion: it is excluded from due/overdue so the owner is
    -- not re-nagged about something they closed, and it contributes nothing to
    -- any paid figure because no payment was ever observed.
    WHEN 'MET' THEN 'SETTLED_LEGACY'::"InstallmentStatus"
    ELSE 'SCHEDULED'::"InstallmentStatus"
  END,
  CASE WHEN o."state" = 'MET' THEN o."settlementAssertedBy" ELSE NULL END,
  CASE WHEN o."state" = 'MET' THEN o."metAt" ELSE NULL END,
  o."createdAt",
  o."updatedAt"
FROM "Commitment" c
JOIN "BusinessObligation" o
  ON o."id" = c."legacyObligationId" AND o."businessId" = c."businessId"
WHERE c."legacyObligationId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Installment" i WHERE i."commitmentId" = c."id" AND i."sequence" = 1
  );

-- Provenance for the migration itself, so "where did this commitment come from"
-- has an answer that is not folklore.
INSERT INTO "PayablesAuditEvent" (
  "businessId", "commitmentId", "eventType", "source", "summary", "metadata",
  "eventHash", "occurredAt", "createdAt"
)
SELECT
  c."businessId",
  c."id",
  'COMMITMENT_MIGRATED_FROM_OBLIGATION',
  'MIGRATION',
  'Migrated from BusinessObligation #' || c."legacyObligationId",
  jsonb_build_object(
    'legacyObligationId', c."legacyObligationId",
    'legacyState', o."state",
    'synthesizedPayment', false
  ),
  -- `md5` rather than `digest(...,'sha256')`: the latter lives in pgcrypto,
  -- which this database does not declare anywhere. The value only has to be
  -- deterministic per source row so a re-run produces the same hash; it is not
  -- a security control. Application-written audit rows use the TS hasher.
  md5('payables-migration:' || c."businessId" || ':' || c."legacyObligationId"),
  NOW(),
  NOW()
FROM "Commitment" c
JOIN "BusinessObligation" o
  ON o."id" = c."legacyObligationId" AND o."businessId" = c."businessId"
WHERE c."legacyObligationId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "PayablesAuditEvent" e
    WHERE e."commitmentId" = c."id"
      AND e."eventType" = 'COMMITMENT_MIGRATED_FROM_OBLIGATION'
  );
