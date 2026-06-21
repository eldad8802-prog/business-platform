-- AlterEnum
-- Receipt document types added to BillingDocumentType.
-- Isolated in its own migration so the ALTER TYPE ... ADD VALUE statements
-- commit before any later migration/DDL can reference the new values
-- (PostgreSQL: a newly added enum value cannot be used in the same transaction
-- in which it was added). Additive only — no DROP, no data change.
ALTER TYPE "BillingDocumentType" ADD VALUE 'RECEIPT';
ALTER TYPE "BillingDocumentType" ADD VALUE 'TAX_INVOICE_RECEIPT';
