-- Secretary → ledger cutover — PREFLIGHT. READ-ONLY: SELECTs only, no write.
--
-- The same counts `scripts/payables/secretary-ledger-cutover.ts` prints in its
-- dry run, for an operator who would rather paste SQL into the database
-- console. Run it as the owner (it reads across businesses, as the backfill
-- migration did). Counts and ids only — no name, note or amount is selected.
--
-- Expected before the cutover:  anything ≥ 0 — this is what the cutover fixes.
-- Expected after the cutover:   uncopied_* = 0, drift_* = 0 except rows listed
--                               in the conflicts query, recurring_with_total = 0.

WITH copied AS (
  SELECT c."id" AS commitment_id, c."legacyObligationId" AS obligation_id, c."status" AS c_status,
         c."scheduleKind" AS kind, c."payeeId", c."payeeNameSnapshot", c."note" AS c_note,
         i."id" AS installment_id, i."status" AS i_status, i."scheduledAmount", i."dueAt" AS i_due,
         EXISTS (
           SELECT 1 FROM "PaymentAllocation" a JOIN "Payment" p ON p."id" = a."paymentId"
           WHERE a."installmentId" = i."id" AND a."reversedAt" IS NULL AND p."status" = 'RECORDED'
         ) AS carries_money
  FROM "Commitment" c
  JOIN "Installment" i ON i."commitmentId" = c."id" AND i."sequence" = 1
  WHERE c."legacyObligationId" IS NOT NULL
),
pairs AS (
  SELECT o."id", o."businessId", o."state", o."recurrence", o."amount", o."dueAt", o."obligeeName",
         o."note", o."followUpAt", k.*
  FROM "BusinessObligation" o
  LEFT JOIN copied k ON k.obligation_id = o."id"
)
SELECT
  count(DISTINCT "businessId")                                                        AS businesses,
  count(*)                                                                            AS obligations,
  count(*) FILTER (WHERE commitment_id IS NOT NULL)                                   AS already_copied,
  count(*) FILTER (WHERE commitment_id IS NULL AND "state" = 'OPEN')                  AS uncopied_open,
  count(*) FILTER (WHERE commitment_id IS NULL AND "state" = 'MET')                   AS uncopied_met,
  count(*) FILTER (WHERE commitment_id IS NULL AND "state" = 'RELEASED')              AS uncopied_released,
  count(*) FILTER (WHERE commitment_id IS NULL AND "recurrence" <> 'NONE')            AS uncopied_recurring,
  count(*) FILTER (WHERE "state" = 'MET' AND i_status = 'SCHEDULED')                  AS drift_met_not_settled,
  count(*) FILTER (WHERE "state" = 'RELEASED' AND c_status <> 'RELEASED')             AS drift_released_not_released,
  count(*) FILTER (WHERE "state" = 'OPEN' AND "scheduledAmount" <> "amount")          AS drift_amount_changed,
  count(*) FILTER (WHERE "state" = 'OPEN' AND i_due <> "dueAt")                       AS drift_due_changed,
  count(*) FILTER (WHERE commitment_id IS NOT NULL AND "payeeId" IS NULL
                   AND "payeeNameSnapshot" <> "obligeeName")                          AS drift_renamed,
  count(*) FILTER (WHERE commitment_id IS NOT NULL
                   AND c_note IS DISTINCT FROM "note")                                AS drift_note_changed,
  count(*) FILTER (WHERE carries_money AND (
                     ("state" = 'MET' AND i_status = 'SCHEDULED')
                  OR ("state" = 'RELEASED' AND c_status <> 'RELEASED')
                  OR ("state" = 'OPEN' AND ("scheduledAmount" <> "amount" OR i_due <> "dueAt"))))
                                                                                      AS conflicts,
  (SELECT count(*) FROM "Commitment"
    WHERE "legacyObligationId" IS NOT NULL AND "scheduleKind" = 'RECURRING'
      AND "totalAmount" IS NOT NULL)                                                  AS recurring_with_total
FROM pairs;

-- The conflicts, by id: rows whose drift touches money on an installment that
-- already carries a payment. The cutover leaves each one alone; the owner decides.
WITH copied AS (
  SELECT c."legacyObligationId" AS obligation_id, c."status" AS c_status, i."id" AS installment_id,
         i."status" AS i_status, i."scheduledAmount", i."dueAt" AS i_due
  FROM "Commitment" c
  JOIN "Installment" i ON i."commitmentId" = c."id" AND i."sequence" = 1
  WHERE c."legacyObligationId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "PaymentAllocation" a JOIN "Payment" p ON p."id" = a."paymentId"
      WHERE a."installmentId" = i."id" AND a."reversedAt" IS NULL AND p."status" = 'RECORDED'
    )
)
SELECT o."businessId", o."id" AS obligation_id, k.installment_id, o."state" AS obligation_state
FROM "BusinessObligation" o
JOIN copied k ON k.obligation_id = o."id"
WHERE (o."state" = 'MET' AND k.i_status = 'SCHEDULED')
   OR (o."state" = 'RELEASED' AND k.c_status <> 'RELEASED')
   OR (o."state" = 'OPEN' AND (k."scheduledAmount" <> o."amount" OR k.i_due <> o."dueAt"))
ORDER BY o."businessId", o."id";
