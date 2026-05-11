-- AlterEnum
ALTER TYPE "BillingDocumentType" ADD VALUE 'QUOTE';

-- AlterTable
ALTER TABLE "BillingDocument" ADD COLUMN     "validUntil" TIMESTAMP(3),
ADD COLUMN     "convertedToInvoiceId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_convertedToInvoiceId_key" ON "BillingDocument"("convertedToInvoiceId");

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_convertedToInvoiceId_fkey" FOREIGN KEY ("convertedToInvoiceId") REFERENCES "BillingDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
