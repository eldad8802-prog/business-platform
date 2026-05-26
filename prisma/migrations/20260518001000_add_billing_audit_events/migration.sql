-- Additive-only Phase 3A dedicated Billing legal audit foundation.
CREATE TABLE "BillingAuditEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "billingDocumentId" INTEGER,
    "actorUserId" INTEGER,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "eventHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAuditEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BillingAuditEvent"
ADD CONSTRAINT "BillingAuditEvent_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillingAuditEvent"
ADD CONSTRAINT "BillingAuditEvent_billingDocumentId_fkey"
FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BillingAuditEvent"
ADD CONSTRAINT "BillingAuditEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BillingAuditEvent_businessId_occurredAt_idx"
ON "BillingAuditEvent"("businessId", "occurredAt");

CREATE INDEX "BillingAuditEvent_billingDocumentId_occurredAt_idx"
ON "BillingAuditEvent"("billingDocumentId", "occurredAt");

CREATE INDEX "BillingAuditEvent_eventType_occurredAt_idx"
ON "BillingAuditEvent"("eventType", "occurredAt");
