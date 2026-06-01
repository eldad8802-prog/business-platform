-- Phase 2: Receiving sessions as inventory reality.
-- Draft receiving sessions do not mutate stock; only posted sessions create movements in service code.
-- ReceivingLine intentionally has no movementId relation in this phase.

CREATE TYPE "ReceivingSessionStatus" AS ENUM (
  'DRAFT',
  'POSTED',
  'VOIDED'
);

CREATE TABLE "ReceivingSession" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "purchaseOrderId" INTEGER NOT NULL,
  "status" "ReceivingSessionStatus" NOT NULL DEFAULT 'DRAFT',
  "receivedAt" TIMESTAMP(3),
  "postedAt" TIMESTAMP(3),
  "createdByUserId" INTEGER,
  "postedByUserId" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReceivingSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReceivingLine" (
  "id" SERIAL NOT NULL,
  "receivingSessionId" INTEGER NOT NULL,
  "purchaseOrderLineId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "receivedQty" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReceivingLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReceivingSession_businessId_idx" ON "ReceivingSession"("businessId");
CREATE INDEX "ReceivingSession_businessId_status_idx" ON "ReceivingSession"("businessId", "status");
CREATE INDEX "ReceivingSession_businessId_createdAt_idx" ON "ReceivingSession"("businessId", "createdAt");
CREATE INDEX "ReceivingSession_purchaseOrderId_idx" ON "ReceivingSession"("purchaseOrderId");

CREATE INDEX "ReceivingLine_receivingSessionId_idx" ON "ReceivingLine"("receivingSessionId");
CREATE INDEX "ReceivingLine_purchaseOrderLineId_idx" ON "ReceivingLine"("purchaseOrderLineId");
CREATE INDEX "ReceivingLine_itemId_idx" ON "ReceivingLine"("itemId");

ALTER TABLE "ReceivingSession"
  ADD CONSTRAINT "ReceivingSession_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceivingSession"
  ADD CONSTRAINT "ReceivingSession_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceivingLine"
  ADD CONSTRAINT "ReceivingLine_receivingSessionId_fkey"
  FOREIGN KEY ("receivingSessionId") REFERENCES "ReceivingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceivingLine"
  ADD CONSTRAINT "ReceivingLine_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReceivingLine"
  ADD CONSTRAINT "ReceivingLine_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
