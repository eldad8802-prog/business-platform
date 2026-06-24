-- Purchasing Lifecycle Alignment — Phase D (Status Honesty).
-- Adds PurchaseOrder.sharedAt: the honest event timestamp for "order shared/sent
-- to supplier" (SENT is retired as a stored lifecycle status). Additive, nullable,
-- no backfill. No stored fulfillment status (fulfillment stays derived, Phase B).
-- No enum changes; existing PurchaseOrderStatus values are untouched.

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "sharedAt" TIMESTAMP(3);
