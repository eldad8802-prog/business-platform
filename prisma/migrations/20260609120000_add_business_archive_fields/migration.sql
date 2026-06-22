-- AlterTable
ALTER TABLE "Business" ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedByUserId" INTEGER;

-- CreateIndex
CREATE INDEX "Business_archivedAt_idx" ON "Business"("archivedAt");

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_archivedByUserId_fkey" FOREIGN KEY ("archivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
