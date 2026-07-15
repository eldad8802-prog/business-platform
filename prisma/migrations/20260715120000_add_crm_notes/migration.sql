-- CreateEnum
CREATE TYPE "CrmSubjectType" AS ENUM ('CUSTOMER', 'SUPPLIER');

-- CreateTable
CREATE TABLE "CrmNote" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "subjectType" "CrmSubjectType" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmNote_businessId_subjectType_subjectId_createdAt_idx" ON "CrmNote"("businessId", "subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmNote_createdByUserId_idx" ON "CrmNote"("createdByUserId");

-- AddForeignKey
ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
