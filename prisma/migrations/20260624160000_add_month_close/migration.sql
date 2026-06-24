-- Accountant Package — Phase A.1 (Month Closing minimal).
-- Adds a soft, append-style monthly close. One row per (business, year, month);
-- a row is only materialized when the month is CLOSED. No source data is ever
-- deleted or mutated by this table. Reopen / AMENDED are out of scope for Phase A.

-- CreateEnum
CREATE TYPE "MonthCloseStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "MonthClose" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "MonthCloseStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedByUserId" INTEGER,
    "packageGeneratedAt" TIMESTAMP(3),
    "snapshotHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthClose_businessId_year_month_key" ON "MonthClose"("businessId", "year", "month");

-- CreateIndex
CREATE INDEX "MonthClose_businessId_status_idx" ON "MonthClose"("businessId", "status");

-- AddForeignKey
ALTER TABLE "MonthClose" ADD CONSTRAINT "MonthClose_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthClose" ADD CONSTRAINT "MonthClose_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
