-- CreateTable
CREATE TABLE "ExtractionSnapshot" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceChannel" TEXT NOT NULL,
    "liveEngineVersion" TEXT NOT NULL,
    "ocrEngine" TEXT NOT NULL,
    "ocrVersion" TEXT NOT NULL,
    "ocrTextHash" TEXT,
    "vendorName" TEXT,
    "documentType" TEXT,
    "direction" TEXT,
    "amount" DOUBLE PRECISION,
    "date" TIMESTAMP(3),
    "category" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "amountConfidence" TEXT,
    "vendorConfidence" TEXT,
    "dateConfidence" TEXT,
    "categoryConfidence" TEXT,
    "isFinancial" BOOLEAN,
    "amountEligible" BOOLEAN,
    "financialEvidenceLevel" TEXT,
    "guardrailRoute" TEXT,
    "rawResult" JSONB NOT NULL,

    CONSTRAINT "ExtractionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewEvent" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerUserId" INTEGER NOT NULL,
    "approvedAs" TEXT NOT NULL,
    "explicitFinancial" BOOLEAN NOT NULL,
    "profileId" TEXT,
    "vendorBelief" TEXT,
    "vendorFinal" TEXT,
    "directionBelief" TEXT,
    "directionFinal" TEXT,
    "verdicts" JSONB NOT NULL,
    "rawBelief" JSONB NOT NULL,
    "rawFinal" JSONB NOT NULL,

    CONSTRAINT "ReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractionSnapshot_documentId_idx" ON "ExtractionSnapshot"("documentId");

-- CreateIndex
CREATE INDEX "ExtractionSnapshot_businessId_occurredAt_idx" ON "ExtractionSnapshot"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "ReviewEvent_documentId_idx" ON "ReviewEvent"("documentId");

-- CreateIndex
CREATE INDEX "ReviewEvent_businessId_occurredAt_idx" ON "ReviewEvent"("businessId", "occurredAt");

