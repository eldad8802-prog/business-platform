/*
  Warnings:

  - You are about to drop the column `businessName` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `city` on the `BusinessProfile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[businessId]` on the table `BusinessProfile` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `businessId` to the `BusinessProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `BusinessProfile` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BusinessServiceType" AS ENUM ('SERVICE', 'PRODUCT');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'OPEN', 'QUALIFIED', 'QUOTED', 'WON', 'LOST', 'DROPPED');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'EMAIL', 'PHONE', 'OTHER');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConversationStage" AS ENUM ('NEW', 'QUALIFIED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ConversationOutcomeStatus" AS ENUM ('OPEN', 'QUALIFIED', 'QUOTE_REQUESTED', 'QUOTE_SENT', 'WON', 'LOST', 'DROPPED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('CUSTOMER', 'BUSINESS_USER', 'SYSTEM', 'AI');

-- CreateEnum
CREATE TYPE "ReplySuggestionStatus" AS ENUM ('GENERATED', 'SHOWN', 'SELECTED', 'SENT', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('REPLY', 'CONTENT', 'PRICING', 'TASK', 'FOLLOWUP', 'PROMOTION', 'GENERAL');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecommendationOutcomeStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'EDITED', 'EXECUTED', 'IGNORED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BusinessImpactType" AS ENUM ('REPLY_RECEIVED', 'LEAD_CREATED', 'DEAL_WON', 'CONTENT_ENGAGEMENT', 'REVENUE', 'NONE');

-- CreateEnum
CREATE TYPE "FinancialDocumentType" AS ENUM ('RECEIPT', 'INVOICE', 'TAX', 'BANK', 'OTHER');

-- CreateEnum
CREATE TYPE "FinancialDocumentStatus" AS ENUM ('UPLOADED', 'CLASSIFIED', 'REVIEWED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED');

-- AlterTable
ALTER TABLE "BusinessProfile" DROP COLUMN "businessName",
DROP COLUMN "category",
DROP COLUMN "city",
ADD COLUMN     "brandVoice" TEXT,
ADD COLUMN     "businessId" INTEGER NOT NULL,
ADD COLUMN     "commonObjections" TEXT,
ADD COLUMN     "commonQuestions" TEXT,
ADD COLUMN     "differentiators" TEXT,
ADD COLUMN     "goals" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "salesStyle" TEXT,
ADD COLUMN     "targetAudience" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "Business" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "businessType" TEXT,
    "pricingType" TEXT,
    "toneProfile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessService" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BusinessServiceType" NOT NULL,
    "description" TEXT,
    "basePrice" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerName" TEXT,
    "phone" TEXT,
    "sourceChannel" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "temperature" DOUBLE PRECISION,
    "currentStage" TEXT,
    "valueEstimate" DOUBLE PRECISION,
    "quotedPrice" DOUBLE PRECISION,
    "finalPrice" DOUBLE PRECISION,
    "currency" TEXT DEFAULT 'ILS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "leadId" INTEGER,
    "businessServiceId" INTEGER,
    "quotedPrice" DOUBLE PRECISION,
    "finalPrice" DOUBLE PRECISION,
    "currency" TEXT DEFAULT 'ILS',
    "estimatedCost" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "estimatedDurationMinutes" INTEGER,
    "actualDurationMinutes" INTEGER,
    "discountAmount" DOUBLE PRECISION,
    "discountPercent" DOUBLE PRECISION,
    "grossProfitAmount" DOUBLE PRECISION,
    "grossMarginPercent" DOUBLE PRECISION,
    "status" TEXT,
    "lostReason" TEXT,
    "wonAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "leadId" INTEGER,
    "channel" "ConversationChannel" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "currentStage" "ConversationStage",
    "outcomeStatus" "ConversationOutcomeStatus",
    "intentType" TEXT,
    "intentConfidence" DOUBLE PRECISION,
    "sentimentSnapshot" TEXT,
    "temperatureScore" DOUBLE PRECISION,
    "closeProbabilitySnapshot" DOUBLE PRECISION,
    "outcomeReason" TEXT,
    "lostReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "firstResponseLatencySec" INTEGER,
    "avgResponseLatencySec" INTEGER,
    "unansweredInboundCount" INTEGER NOT NULL DEFAULT 0,
    "customerLastInboundAt" TIMESTAMP(3),
    "businessLastOutboundAt" TIMESTAMP(3),
    "lastAnalysisAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "channel" "ConversationChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "senderType" "MessageSenderType" NOT NULL,
    "messageType" TEXT DEFAULT 'text',
    "contentText" TEXT,
    "languageCode" TEXT,
    "intentLabel" TEXT,
    "intentConfidence" DOUBLE PRECISION,
    "sentimentLabel" TEXT,
    "sentimentScore" DOUBLE PRECISION,
    "objectionLabel" TEXT,
    "objectionConfidence" DOUBLE PRECISION,
    "stageLabel" TEXT,
    "urgencyScore" DOUBLE PRECISION,
    "leadScoreSnapshot" DOUBLE PRECISION,
    "generatedFromSuggestionId" INTEGER,
    "recommendationId" INTEGER,
    "wasEditedBeforeSend" BOOLEAN NOT NULL DEFAULT false,
    "replyLatencySec" INTEGER,
    "gotReplyWithin24h" BOOLEAN,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplySuggestion" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "recommendationId" INTEGER,
    "suggestionType" TEXT NOT NULL,
    "variantIndex" INTEGER,
    "text" TEXT NOT NULL,
    "toneLabel" TEXT,
    "strategyLabel" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "status" "ReplySuggestionStatus" NOT NULL DEFAULT 'GENERATED',
    "shownAt" TIMESTAMP(3),
    "selectedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "sentMessageId" INTEGER,
    "wasEdited" BOOLEAN NOT NULL DEFAULT false,
    "customerResponded" BOOLEAN,
    "customerRespondedAt" TIMESTAMP(3),
    "ledToStageAdvance" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "type" "RecommendationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "sourceEngine" TEXT,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationOutcome" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER,
    "outcomeStatus" "RecommendationOutcomeStatus" NOT NULL,
    "outcomeScore" DOUBLE PRECISION,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeToActionSec" INTEGER,
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "businessImpactType" "BusinessImpactType",
    "businessImpactValue" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCostProfile" (
    "id" SERIAL NOT NULL,
    "businessServiceId" INTEGER NOT NULL,
    "materialCost" DOUBLE PRECISION,
    "laborCost" DOUBLE PRECISION,
    "timeMinutes" INTEGER,
    "fixedCostShare" DOUBLE PRECISION,
    "externalCost" DOUBLE PRECISION,
    "desiredMargin" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCostProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRecommendation" (
    "id" SERIAL NOT NULL,
    "businessServiceId" INTEGER NOT NULL,
    "floorPrice" DOUBLE PRECISION,
    "safePrice" DOUBLE PRECISION,
    "recommendedPrice" DOUBLE PRECISION,
    "premiumPrice" DOUBLE PRECISION,
    "confidenceScore" DOUBLE PRECISION,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialDocument" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "docType" "FinancialDocumentType" NOT NULL,
    "month" INTEGER,
    "year" INTEGER,
    "status" "FinancialDocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "extractedData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningSignal" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "signalValue" TEXT NOT NULL,
    "relatedEntityId" INTEGER,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReplySuggestion_sentMessageId_key" ON "ReplySuggestion"("sentMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCostProfile_businessServiceId_key" ON "ServiceCostProfile"("businessServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_businessId_key" ON "BusinessProfile"("businessId");

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessService" ADD CONSTRAINT "BusinessService_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_businessServiceId_fkey" FOREIGN KEY ("businessServiceId") REFERENCES "BusinessService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_generatedFromSuggestionId_fkey" FOREIGN KEY ("generatedFromSuggestionId") REFERENCES "ReplySuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_sentMessageId_fkey" FOREIGN KEY ("sentMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCostProfile" ADD CONSTRAINT "ServiceCostProfile_businessServiceId_fkey" FOREIGN KEY ("businessServiceId") REFERENCES "BusinessService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRecommendation" ADD CONSTRAINT "PricingRecommendation_businessServiceId_fkey" FOREIGN KEY ("businessServiceId") REFERENCES "BusinessService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialDocument" ADD CONSTRAINT "FinancialDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningSignal" ADD CONSTRAINT "LearningSignal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
