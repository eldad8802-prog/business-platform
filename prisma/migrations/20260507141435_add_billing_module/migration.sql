-- CreateEnum
CREATE TYPE "BillingDocumentType" AS ENUM ('TAX_INVOICE');

-- CreateEnum
CREATE TYPE "BillingDocumentStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ISSUED');

-- CreateEnum
CREATE TYPE "BillingPdfRenderStatus" AS ENUM ('PENDING', 'RENDERED', 'FAILED');

-- AlterTable
ALTER TABLE "Coupon" ALTER COLUMN "publicId" DROP DEFAULT;

-- CreateTable
CREATE TABLE "BillingDocument" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "documentType" "BillingDocumentType" NOT NULL,
    "status" "BillingDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "documentNumber" INTEGER,
    "documentNumberFormatted" TEXT,
    "customerId" INTEGER,
    "customerNameSnapshot" TEXT,
    "subtotalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "issuedAt" TIMESTAMP(3),
    "issuedByUserId" INTEGER,
    "createdByUserId" INTEGER,
    "issuedSnapshot" JSONB,
    "pdfRenderStatus" "BillingPdfRenderStatus" NOT NULL DEFAULT 'PENDING',
    "pdfTemplateVersion" TEXT,
    "pdfStorageKey" TEXT,
    "pdfHash" TEXT,
    "pdfRenderedAt" TIMESTAMP(3),
    "pdfRenderError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingDocumentLine" (
    "id" SERIAL NOT NULL,
    "billingDocumentId" INTEGER NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "vatRatePercent" DECIMAL(5,2) NOT NULL,
    "lineSubtotal" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingDocumentNumberSequence" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "documentType" "BillingDocumentType" NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDocumentNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingDocument_businessId_status_issuedAt_idx" ON "BillingDocument"("businessId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "BillingDocument_businessId_createdAt_idx" ON "BillingDocument"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingDocument_businessId_customerId_idx" ON "BillingDocument"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "BillingDocument_pdfRenderStatus_idx" ON "BillingDocument"("pdfRenderStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_businessId_documentType_documentNumber_key" ON "BillingDocument"("businessId", "documentType", "documentNumber");

-- CreateIndex
CREATE INDEX "BillingDocumentLine_billingDocumentId_idx" ON "BillingDocumentLine"("billingDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocumentLine_billingDocumentId_lineIndex_key" ON "BillingDocumentLine"("billingDocumentId", "lineIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocumentNumberSequence_businessId_documentType_key" ON "BillingDocumentNumberSequence"("businessId", "documentType");

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocumentLine" ADD CONSTRAINT "BillingDocumentLine_billingDocumentId_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocumentNumberSequence" ADD CONSTRAINT "BillingDocumentNumberSequence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
