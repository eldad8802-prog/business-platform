-- CreateTable
CREATE TABLE "POSApiKey" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "keyHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'POS',
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "POSApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "POSApiKey_keyHash_key" ON "POSApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "POSApiKey_businessId_idx" ON "POSApiKey"("businessId");

-- AddForeignKey
ALTER TABLE "POSApiKey" ADD CONSTRAINT "POSApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
