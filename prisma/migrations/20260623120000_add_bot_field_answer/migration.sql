-- CreateEnum
CREATE TYPE "BotAnswerParseStatus" AS ENUM ('UNPARSED', 'PARSED', 'FAILED', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "BotFieldAnswer" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "sourceMessageId" INTEGER,
    "fieldKey" TEXT NOT NULL,
    "partyRole" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "rawValue" TEXT NOT NULL,
    "rawKind" TEXT NOT NULL DEFAULT 'text',
    "parsedValue" JSONB,
    "parseStatus" "BotAnswerParseStatus" NOT NULL DEFAULT 'UNPARSED',
    "confidence" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByAnswerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotFieldAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotFieldAnswer_businessId_idx" ON "BotFieldAnswer"("businessId");

-- CreateIndex
CREATE INDEX "BotFieldAnswer_conversationId_fieldKey_idx" ON "BotFieldAnswer"("conversationId", "fieldKey");

-- CreateIndex
CREATE INDEX "BotFieldAnswer_sourceMessageId_idx" ON "BotFieldAnswer"("sourceMessageId");

-- CreateIndex
CREATE INDEX "BotFieldAnswer_parseStatus_idx" ON "BotFieldAnswer"("parseStatus");

-- CreateIndex
-- Partial unique index: at most one CURRENT answer per (conversationId, fieldKey).
-- Hand-added; Prisma @@unique cannot express a WHERE predicate.
CREATE UNIQUE INDEX "BotFieldAnswer_conversation_field_current_key" ON "BotFieldAnswer"("conversationId", "fieldKey") WHERE "supersededAt" IS NULL;

-- AddForeignKey
ALTER TABLE "BotFieldAnswer" ADD CONSTRAINT "BotFieldAnswer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFieldAnswer" ADD CONSTRAINT "BotFieldAnswer_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotFieldAnswer" ADD CONSTRAINT "BotFieldAnswer_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
