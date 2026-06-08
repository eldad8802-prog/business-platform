-- H1b-1: Billing / FinancialEvent FK hardening — CASCADE → RESTRICT (four constraints only).

ALTER TABLE "BillingDocument" DROP CONSTRAINT "BillingDocument_businessId_fkey";

ALTER TABLE "BillingDocument"
ADD CONSTRAINT "BillingDocument_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillingDocumentNumberSequence" DROP CONSTRAINT "BillingDocumentNumberSequence_businessId_fkey";

ALTER TABLE "BillingDocumentNumberSequence"
ADD CONSTRAINT "BillingDocumentNumberSequence_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinancialEvent" DROP CONSTRAINT "FinancialEvent_businessId_fkey";

ALTER TABLE "FinancialEvent"
ADD CONSTRAINT "FinancialEvent_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinancialEvent" DROP CONSTRAINT "FinancialEvent_billingDocumentId_fkey";

ALTER TABLE "FinancialEvent"
ADD CONSTRAINT "FinancialEvent_billingDocumentId_fkey"
FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
