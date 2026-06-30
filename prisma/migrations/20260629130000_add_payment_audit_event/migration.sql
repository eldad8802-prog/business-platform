-- CreateTable
CREATE TABLE "PaymentAuditEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "paymentRequestId" INTEGER,
    "actorUserId" INTEGER,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "eventHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAuditEvent_businessId_occurredAt_idx" ON "PaymentAuditEvent"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentAuditEvent_paymentRequestId_occurredAt_idx" ON "PaymentAuditEvent"("paymentRequestId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentAuditEvent_eventType_occurredAt_idx" ON "PaymentAuditEvent"("eventType", "occurredAt");

-- AddForeignKey
ALTER TABLE "PaymentAuditEvent" ADD CONSTRAINT "PaymentAuditEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAuditEvent" ADD CONSTRAINT "PaymentAuditEvent_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAuditEvent" ADD CONSTRAINT "PaymentAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
