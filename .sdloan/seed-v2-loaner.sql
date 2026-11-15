-- Service Desk loans (migration 20261201090000) — VERSION-2 handovers written BEFORE the loans migration, the way the
-- handover record (20261130090000, #1128) allows them: one with the loaner exception (reason + approver = actor +
-- approval time) although no loan exists (the loan table does not exist yet), and one plain. The loans migration's
-- handover rule (no loan out ⇒ no loaner exception) judges NEW rows only: these rows must stay byte-identical, must not
-- block the migration, and are counted by the preflight (INFO 15) and the evidence (INFO 23).
--
--   psql -X -q -v ON_ERROR_STOP=1 "<owner url>" -f .sdloan/seed-v2-loaner.sql
--
-- One business 'loan-pre-v2' (a separate business: the 'hov-legacy' rows stay exactly the five version-1 rows), one
-- user, one customer, two IN_SHOP cases (caseNumber 961, 962) with their case.opened events and one handover each:
--   961  version 2, zero balance, the loaner exception (reason + approver + approval time), NO loan
--   962  version 2, zero balance, no exception (the normal handover)
-- Runs on the handover-record chain (.sdhov/chain.sh) BEFORE 20261201090000; refuses after it. Re-run safe (writes
-- nothing when 'loan-pre-v2' exists). Synthetic only.
SET client_encoding = 'UTF8';
DO $guard$
BEGIN
  IF to_regclass('public."ServiceLoan"') IS NOT NULL THEN
    RAISE EXCEPTION 'SEED_V2_LOANER: 20261201090000 is already applied — these rows must be written before it; nothing was written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover' AND column_name = 'loanerApprovedAt') THEN
    RAISE EXCEPTION 'SEED_V2_LOANER: 20261130090000 is not applied; nothing was written';
  END IF;
END
$guard$;
BEGIN;
DO $$
DECLARE b int; u int; c int; k int; i int;
BEGIN
  IF EXISTS (SELECT 1 FROM "Business" WHERE name = 'loan-pre-v2') THEN
    RAISE NOTICE 'SEED_V2_LOANER: loan-pre-v2 exists; nothing written';
    RETURN;
  END IF;
  INSERT INTO "Business" (name, "updatedAt") VALUES ('loan-pre-v2', now()) RETURNING id INTO b;
  PERFORM set_config('app.current_business_id', b::text, true);
  INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('loan-pre-v2-' || b || '@lab.invalid', b, now()) RETURNING id INTO u;
  INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (b, 'לקוח סינתטי', now()) RETURNING id INTO c;
  FOR i IN 1..2 LOOP
    INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
      VALUES (b, 960 + i, 'IN_SHOP', c, 'תקלה סינתטית') RETURNING id INTO k;
    INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                    "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
      VALUES (b, k, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', u, 'loan-pre-v2-' || k);
    INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "recordVersion", "openBalanceAgorot",
                                   "overpaidAgorot", "loanerOverrideReason", "loanerApprovedByUserId", "loanerApprovedAt", "actorUserId")
      VALUES (b, k, 'דנה', false, 2, 0, 0,
              CASE i WHEN 1 THEN 'הפריט החלופי יוחזר מחר' END, CASE i WHEN 1 THEN u END, CASE i WHEN 1 THEN now() END, u);
  END LOOP;
END $$;
COMMIT;
