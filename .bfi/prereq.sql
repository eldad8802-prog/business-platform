-- Bank file import (milestone B1) labs: the row-level security and the immutability trigger Production has on
-- the tables this path touches, which the base lab's `db push` builds without. Verbatim from the migrations that
-- ship them (idempotent). ExternalTransaction's RLS comes from .rev/prereq.sql (run by .rev/lab.sh).
--   20260918120000_payables_phase_3_cheques_and_bank_accounts   "BusinessBankAccount": ENABLE + FORCE RLS
--   20260903090000_import_run_execution_ledger                  "ImportRun" / "ImportRunRow": ENABLE + FORCE RLS
--   20260917090100_payables_phase_1a_tenant_rls                 "PayablesAuditEvent": ENABLE + FORCE RLS
--   20260922130000_payables_p4_p6_outbound_foundation            "ExternalTransaction": facts immutable (trigger)

ALTER TABLE "BusinessBankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBankAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p3_tenant ON "BusinessBankAccount";
CREATE POLICY payables_p3_tenant ON "BusinessBankAccount"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ImportRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportRun" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7imp_tenant_read ON "ImportRun";
CREATE POLICY p7imp_tenant_read ON "ImportRun" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_insert ON "ImportRun";
CREATE POLICY p7imp_tenant_insert ON "ImportRun" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_update ON "ImportRun";
CREATE POLICY p7imp_tenant_update ON "ImportRun" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7imp_tenant_delete ON "ImportRun";
CREATE POLICY p7imp_tenant_delete ON "ImportRun" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ImportRunRow carries no businessId of its own: its tenant is its parent's, and the
-- FK with ON DELETE CASCADE makes that structural. The predicate therefore reaches
-- through the parent — a row is visible exactly when its run is.
ALTER TABLE "ImportRunRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportRunRow" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7imp_row_tenant_read ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_read ON "ImportRunRow" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

DROP POLICY IF EXISTS p7imp_row_tenant_insert ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_insert ON "ImportRunRow" FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

DROP POLICY IF EXISTS p7imp_row_tenant_delete ON "ImportRunRow";
CREATE POLICY p7imp_row_tenant_delete ON "ImportRunRow" FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "ImportRun" r
    WHERE r."id" = "ImportRunRow"."importRunId"
      AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
  ));

ALTER TABLE "PayablesAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayablesAuditEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p1a_tenant ON "PayablesAuditEvent";
CREATE POLICY payables_p1a_tenant ON "PayablesAuditEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE OR REPLACE FUNCTION payables_external_transaction_facts_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."businessId"          IS DISTINCT FROM OLD."businessId"
  OR NEW."source"              IS DISTINCT FROM OLD."source"
  OR NEW."externalId"          IS DISTINCT FROM OLD."externalId"
  OR NEW."sourceBankAccountId" IS DISTINCT FROM OLD."sourceBankAccountId"
  OR NEW."direction"           IS DISTINCT FROM OLD."direction"
  OR NEW."amount"              IS DISTINCT FROM OLD."amount"
  OR NEW."currency"            IS DISTINCT FROM OLD."currency"
  OR NEW."bookedAt"            IS DISTINCT FROM OLD."bookedAt"
  OR NEW."valueDate"           IS DISTINCT FROM OLD."valueDate"
  OR NEW."counterpartyName"    IS DISTINCT FROM OLD."counterpartyName"
  OR NEW."reference"           IS DISTINCT FROM OLD."reference"
  OR NEW."description"         IS DISTINCT FROM OLD."description"
  OR NEW."importBatchId"       IS DISTINCT FROM OLD."importBatchId"
  OR NEW."createdAt"           IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'ExternalTransaction facts are immutable (id %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ExternalTransaction_facts_immutable" ON "ExternalTransaction";
CREATE TRIGGER "ExternalTransaction_facts_immutable"
  BEFORE UPDATE ON "ExternalTransaction"
  FOR EACH ROW EXECUTE FUNCTION payables_external_transaction_facts_immutable();
