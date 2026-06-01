-- Phase 3: Remaining decisions live directly on purchase order lines.
-- No receivedQty/remainingQty persistence and no resolution history model.

CREATE TYPE "PurchaseOrderLineRemainingDecision" AS ENUM (
  'KEEP_OPEN',
  'BACKORDER',
  'CLOSED_SHORT'
);

ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "remainingDecision" "PurchaseOrderLineRemainingDecision",
  ADD COLUMN "remainingDecisionQty" DOUBLE PRECISION,
  ADD COLUMN "expectedAt" TIMESTAMP(3),
  ADD COLUMN "remainingDecisionNote" TEXT,
  ADD COLUMN "remainingDecidedAt" TIMESTAMP(3),
  ADD COLUMN "remainingDecidedByUserId" INTEGER;

CREATE INDEX "PurchaseOrderLine_purchaseOrderId_remainingDecision_idx"
  ON "PurchaseOrderLine"("purchaseOrderId", "remainingDecision");
