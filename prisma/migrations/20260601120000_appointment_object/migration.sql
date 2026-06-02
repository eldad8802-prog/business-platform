-- Appointment business object (Step 1 — data layer only).
--
-- ADDITIVE ONLY: creates three new enums + one new `Appointment` table with its
-- indexes and foreign keys. No existing column, enum, constraint, or index is
-- altered or dropped. No backfill, no data migration. Follow-Up, Appointment
-- Request, Inbox, and existing Conversations are untouched.
--
-- Source links (conversation / message / customer / lead) are nullable so future
-- creation paths (bot, public booking, import, API) can persist without a
-- conversation. No Conversion, Service, UI, Calendar, Timeline, or Bot flow here.

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELED');

-- CreateEnum
CREATE TYPE "CreatedByActor" AS ENUM ('OWNER', 'BOT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SourceChannel" AS ENUM ('INBOX_WEB', 'MOBILE', 'WHATSAPP_BOT', 'PUBLIC_BOOKING', 'EXTERNAL_API', 'IMPORT');

-- CreateTable
CREATE TABLE "Appointment" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "startsAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "title" TEXT,
    "notes" TEXT,
    "createdByActor" "CreatedByActor" NOT NULL,
    "sourceChannel" "SourceChannel" NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "sourceConversationId" INTEGER,
    "sourceMessageId" INTEGER,
    "customerId" INTEGER,
    "leadId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_businessId_startsAt_idx" ON "Appointment"("businessId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_businessId_status_idx" ON "Appointment"("businessId", "status");

-- CreateIndex
CREATE INDEX "Appointment_businessId_createdAt_idx" ON "Appointment"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
