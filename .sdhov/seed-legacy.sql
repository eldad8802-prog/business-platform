-- Service Desk handover record (migration 20261130090000) — LEGACY handovers, written the pre-migration way, for a lab
-- where the migration is NOT yet applied. Used by .sdhov/chain.sh (L) and by any combined lab that applies
-- 20261130090000 after other migrations: run it BEFORE 20261130090000, once per database (owner role, synthetic only).
--
--   psql -X -q -v ON_ERROR_STOP=1 "<owner url>" -f .sdhov/seed-legacy.sql
--
-- One business 'hov-legacy', one user, one customer, five IN_SHOP cases (caseNumber 901..905), each with its case.opened
-- event and ONE handover, in this order (the battery's L checks rely on it: [1] = debt, [2] = negative balance):
--   1  zero balance, no signature                    (the normal handover)
--   2  open debt 5000 with only a reason, no approver (the legacy debt override)
--   3  balance -300                                  (the legacy form of an overpayment)
--   4  zero balance with the loaner exception reason
--   5  an erased row (no receiver, no actor, erasedAt)
-- Prerequisites: the P4 lab + M1 (.sd3p4/lab.sh, --deploy-only, .sdm1/chain.sh). Refuses to run twice (the business
-- name is checked first) so the five rows stay the only 'hov-legacy' rows.
-- the file is UTF-8 (Hebrew synthetic names): say so, whatever the client default (e.g. WIN1255 on a Windows lab)
SET client_encoding = 'UTF8';
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "Business" WHERE name = 'hov-legacy') THEN
    RAISE EXCEPTION 'SEED_LEGACY: hov-legacy rows already exist; nothing was written';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover' AND column_name = 'recordVersion') THEN
    RAISE EXCEPTION 'SEED_LEGACY: 20261130090000 is already applied — legacy rows must be written before it; nothing was written';
  END IF;
END
$guard$;
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('hov-legacy', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('hov-legacy-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'לקוח סינתטי', now());
DO $$
DECLARE b int := currval(pg_get_serial_sequence('"Business"', 'id')); u int := currval(pg_get_serial_sequence('"User"', 'id'));
        c int := currval(pg_get_serial_sequence('"Customer"', 'id')); k int; i int;
BEGIN
  FOR i IN 1..5 LOOP
    INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
      VALUES (b, 900 + i, 'IN_SHOP', c, 'תקלה סינתטית') RETURNING id INTO k;
    INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                    "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
      VALUES (b, k, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', u, 'hov-legacy-' || k);
    INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "debtOverrideReason",
                                   "loanerOverrideReason", "actorUserId", "erasedAt")
      VALUES (b, k,
              CASE i WHEN 5 THEN NULL ELSE 'דנה' END, i <> 1,
              CASE i WHEN 2 THEN 5000 WHEN 3 THEN -300 WHEN 5 THEN 1000 ELSE 0 END,
              CASE i WHEN 2 THEN 'ישלם מחר' END,
              CASE i WHEN 4 THEN 'ההשאלה תוחזר מחר' END,
              CASE i WHEN 5 THEN NULL ELSE u END,
              CASE i WHEN 5 THEN now() END);
  END LOOP;
END $$;
COMMIT;
