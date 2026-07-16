-- CreateTable
CREATE TABLE "CrmAttachment" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "subjectType" "CrmSubjectType" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmAttachment_businessId_storageKey_key" ON "CrmAttachment"("businessId", "storageKey");

-- CreateIndex
CREATE INDEX "CrmAttachment_businessId_subjectType_subjectId_createdAt_idx" ON "CrmAttachment"("businessId", "subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmAttachment_uploadedByUserId_idx" ON "CrmAttachment"("uploadedByUserId");

-- AddForeignKey
ALTER TABLE "CrmAttachment" ADD CONSTRAINT "CrmAttachment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAttachment" ADD CONSTRAINT "CrmAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
