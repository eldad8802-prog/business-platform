-- CreateTable
CREATE TABLE "BusinessObligation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "obligeeName" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "recurrenceSeriesId" TEXT,
    "note" TEXT,
    "followUpAt" TIMESTAMP(3),
    "settlementAssertedBy" TEXT,
    "metAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessObligationOrientation" (
    "businessId" INTEGER NOT NULL,
    "oriented" BOOLEAN NOT NULL DEFAULT false,
    "orientedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessObligationOrientation_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE INDEX "BusinessObligation_businessId_state_idx" ON "BusinessObligation"("businessId", "state");

-- CreateIndex
CREATE INDEX "BusinessObligation_businessId_dueAt_idx" ON "BusinessObligation"("businessId", "dueAt");

-- CreateIndex
CREATE INDEX "BusinessObligation_recurrenceSeriesId_idx" ON "BusinessObligation"("recurrenceSeriesId");

-- AddForeignKey
ALTER TABLE "BusinessObligation" ADD CONSTRAINT "BusinessObligation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessObligationOrientation" ADD CONSTRAINT "BusinessObligationOrientation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
