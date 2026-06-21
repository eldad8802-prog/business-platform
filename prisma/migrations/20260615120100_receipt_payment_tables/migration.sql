-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHECK', 'CREDIT_CARD', 'BIT', 'PAYBOX', 'OTHER');

-- CreateTable
CREATE TABLE "BillingReceiptPayment" (
    "id" SERIAL NOT NULL,
    "billingDocumentId" INTEGER NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "bankName" TEXT,
    "bankBranch" TEXT,
    "bankAccountNumber" TEXT,
    "checkNumber" TEXT,
    "checkDueDate" TIMESTAMP(3),
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingReceiptPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPaymentAllocation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "receiptDocumentId" INTEGER NOT NULL,
    "invoiceDocumentId" INTEGER NOT NULL,
    "allocatedAmount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingReceiptPayment_billingDocumentId_idx" ON "BillingReceiptPayment"("billingDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingReceiptPayment_billingDocumentId_lineIndex_key" ON "BillingReceiptPayment"("billingDocumentId", "lineIndex");

-- CreateIndex
CREATE INDEX "BillingPaymentAllocation_businessId_invoiceDocumentId_idx" ON "BillingPaymentAllocation"("businessId", "invoiceDocumentId");

-- CreateIndex
CREATE INDEX "BillingPaymentAllocation_businessId_receiptDocumentId_idx" ON "BillingPaymentAllocation"("businessId", "receiptDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAllocation_receiptDocumentId_invoiceDocumentI_key" ON "BillingPaymentAllocation"("receiptDocumentId", "invoiceDocumentId");

-- AddForeignKey
ALTER TABLE "BillingReceiptPayment" ADD CONSTRAINT "BillingReceiptPayment_billingDocumentId_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAllocation" ADD CONSTRAINT "BillingPaymentAllocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAllocation" ADD CONSTRAINT "BillingPaymentAllocation_receiptDocumentId_fkey" FOREIGN KEY ("receiptDocumentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAllocation" ADD CONSTRAINT "BillingPaymentAllocation_invoiceDocumentId_fkey" FOREIGN KEY ("invoiceDocumentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
