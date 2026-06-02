-- CreateEnum
CREATE TYPE "WhatsAppAttachmentImportStatus" AS ENUM ('processing', 'imported', 'skipped_duplicate', 'failed');

-- CreateTable
CREATE TABLE "WhatsAppAttachmentImport" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "wamid" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "fromPhone" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "filename" TEXT,
    "contentHashSha256" TEXT NOT NULL,
    "status" "WhatsAppAttachmentImportStatus" NOT NULL,
    "error" TEXT,
    "documentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAttachmentImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAttachmentImport_documentId_key" ON "WhatsAppAttachmentImport"("documentId");

-- CreateIndex
CREATE INDEX "WhatsAppAttachmentImport_businessId_createdAt_idx" ON "WhatsAppAttachmentImport"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppAttachmentImport_documentId_idx" ON "WhatsAppAttachmentImport"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAttachmentImport_businessId_wamid_key" ON "WhatsAppAttachmentImport"("businessId", "wamid");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAttachmentImport_businessId_contentHashSha256_key" ON "WhatsAppAttachmentImport"("businessId", "contentHashSha256");

-- AddForeignKey
ALTER TABLE "WhatsAppAttachmentImport" ADD CONSTRAINT "WhatsAppAttachmentImport_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAttachmentImport" ADD CONSTRAINT "WhatsAppAttachmentImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
