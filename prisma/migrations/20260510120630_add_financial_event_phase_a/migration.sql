-- CreateEnum
CREATE TYPE "FinancialEventDirection" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "FinancialEventSourceType" AS ENUM ('BILLING_INVOICE', 'OCR_DOCUMENT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "FinancialEventStatus" AS ENUM ('POSTED');

-- CreateTable
CREATE TABLE "FinancialEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "direction" "FinancialEventDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "counterpartyName" TEXT,
    "sourceType" "FinancialEventSourceType" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "status" "FinancialEventStatus" NOT NULL,
    "billingDocumentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_billingDocumentId_key" ON "FinancialEvent"("billingDocumentId");

-- CreateIndex
CREATE INDEX "FinancialEvent_businessId_occurredAt_idx" ON "FinancialEvent"("businessId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_businessId_sourceType_sourceKey_key" ON "FinancialEvent"("businessId", "sourceType", "sourceKey");

-- AddForeignKey
ALTER TABLE "FinancialEvent" ADD CONSTRAINT "FinancialEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvent" ADD CONSTRAINT "FinancialEvent_billingDocumentId_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
