-- Phase 4: Basic cost layer only.
-- Manual cost remains InventoryItem.costPerUnit.
-- PurchaseOrderLine.unitCost is purchase intent.
-- ReceivingLine.unitCost is receiving evidence.
-- Last purchase cost is updated by service code only when a receiving session is posted.

ALTER TABLE "InventoryItem"
  ADD COLUMN "lastPurchaseCost" DOUBLE PRECISION,
  ADD COLUMN "lastPurchaseCostAt" TIMESTAMP(3);

ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "unitCost" DOUBLE PRECISION;

ALTER TABLE "ReceivingLine"
  ADD COLUMN "unitCost" DOUBLE PRECISION;
