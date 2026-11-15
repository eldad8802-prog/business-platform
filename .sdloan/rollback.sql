-- Rollback of 20261201090000_service_desk_loans — only for a failed or abandoned rollout, run by the migration owner in
-- ONE transaction, BEFORE any product code lends anything (the code PR merges only after the migration). It REFUSES when
-- a loan exists: a loan is a record of equipment at a customer and is never dropped silently — the owner decides instead.
-- The migration replaced no existing function, so the rollback restores nothing: it drops the two triggers it put on
-- ServiceCase / ServiceHandover, its two tables, its functions and types, and the ledger row (a later
-- `prisma migrate deploy` applies the migration again).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceLoan") OR EXISTS (SELECT 1 FROM "ServiceLoanEvent") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a loan exists (equipment lent to a customer is a permanent record); nothing was changed';
  END IF;
END
$do$;

DROP TRIGGER "ServiceCase_loan_exit_guard" ON "ServiceCase";
DROP TRIGGER "ServiceHandover_loan_guard" ON "ServiceHandover";
DROP TABLE "ServiceLoanEvent";
DROP TABLE "ServiceLoan";
DROP FUNCTION public.service_loan_insert_guard();
DROP FUNCTION public.service_loan_guard();
DROP FUNCTION public.service_loan_has_event();
DROP FUNCTION public.service_loan_event_matches_loan();
DROP FUNCTION public.service_loan_event_guard();
DROP FUNCTION public.service_loan_case_exit_guard();
DROP FUNCTION public.service_loan_handover_guard();
DROP FUNCTION public.service_loan_erase_business();
DROP TYPE "ServiceLoanApprovalKind";
DROP TYPE "ServiceLoanEventKind";
DROP TYPE "ServiceLoanCloseReason";
DROP TYPE "ServiceLoanCondition";
DROP TYPE "ServiceLoanState";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261201090000_service_desk_loans';
COMMIT;
