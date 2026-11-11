-- Rollback of 20261126090000_service_desk_case_charge — only for a failed or abandoned rollout, run by the migration
-- owner in ONE transaction, BEFORE any product code writes these tables (the code PR merges only after the migration).
-- It refuses when a charge or a link already exists: then data would be lost, and the owner decides instead.
-- Enum values added to ServiceEventType / ServiceCaseAction cannot be removed in PostgreSQL; they stay unused and a
-- re-application skips them (ADD VALUE IF NOT EXISTS). After this script: `prisma migrate resolve --rolled-back
-- 20261126090000_service_desk_case_charge` so the ledger matches.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceCaseCharge") OR EXISTS (SELECT 1 FROM "ServiceCaseBillingLink") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: charge or link rows exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "action"::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the journal already holds charge / link records; nothing was changed';
  END IF;
END
$do$;
ALTER TABLE "ServiceCaseEvent" DROP CONSTRAINT IF EXISTS "ServiceCaseEvent_charge_in_place";
DROP TABLE "ServiceCaseBillingLink";
DROP TABLE "ServiceCaseCharge";
DROP FUNCTION public.service_case_charge_erase_business();
DROP FUNCTION public.service_case_billing_link_guard();
DROP FUNCTION public.service_case_charge_guard();
DROP FUNCTION public.service_charge_in_erasure(oid);
DROP TYPE "ServiceBillingLinkRole";
DROP TYPE "ServiceChargeSource";
DROP TYPE "ServiceChargeMode";
COMMIT;
