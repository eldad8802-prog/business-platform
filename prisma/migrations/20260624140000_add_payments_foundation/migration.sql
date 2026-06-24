-- P1: Payment Links Foundation (external clearing).
-- Additive only: new enums + tables + indexes + FKs. No changes to existing
-- tables. Dubiz stores NO card data — only statuses, identifiers, the payment
-- link, webhook events, and links to document/customer.
--
-- NOT applied to Production by this change. Apply via the normal migrate flow
-- against dev/preview first.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('TRANZILA');

-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentWebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'UNMATCHED');

-- CreateTable
CREATE TABLE "BusinessPaymentConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "merchantId" TEXT,
    "credentialEncrypted" TEXT,
    "credentialIv" TEXT,
    "credentialTag" TEXT,
    "encryptionKeyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPaymentConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "billingDocumentId" INTEGER,
    "provider" "PaymentProvider" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "description" TEXT,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "paymentUrl" TEXT,
    "providerRequestId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" SERIAL NOT NULL,
    "paymentRequestId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "status" "PaymentTransactionStatus" NOT NULL,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" SERIAL NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventType" TEXT,
    "providerEventId" TEXT,
    "payload" JSONB NOT NULL,
    "processingStatus" "PaymentWebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessPaymentConnection_businessId_isActive_idx" ON "BusinessPaymentConnection"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPaymentConnection_businessId_provider_key" ON "BusinessPaymentConnection"("businessId", "provider");

-- CreateIndex
CREATE INDEX "PaymentRequest_businessId_status_idx" ON "PaymentRequest"("businessId", "status");

-- CreateIndex
CREATE INDEX "PaymentRequest_businessId_createdAt_idx" ON "PaymentRequest"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_provider_providerRequestId_idx" ON "PaymentRequest"("provider", "providerRequestId");

-- CreateIndex
CREATE INDEX "PaymentRequest_businessId_billingDocumentId_idx" ON "PaymentRequest"("businessId", "billingDocumentId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_paymentRequestId_idx" ON "PaymentTransaction"("paymentRequestId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_provider_providerTransactionId_idx" ON "PaymentTransaction"("provider", "providerTransactionId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_processingStatus_createdAt_idx" ON "PaymentWebhookEvent"("processingStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_providerEventId_key" ON "PaymentWebhookEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "BusinessPaymentConnection" ADD CONSTRAINT "BusinessPaymentConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_billingDocumentId_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
