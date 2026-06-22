-- CreateEnum
CREATE TYPE "BillingAuthorityEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "BillingAuthorityAppStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "BillingAuthorityConnectionStatus" AS ENUM ('DISCONNECTED', 'AUTHORIZATION_REQUIRED', 'CONNECTED', 'VALIDATED', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "BillingAuthoritySubmissionStatus" AS ENUM ('NOT_REQUIRED', 'READY', 'PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingAuthoritySubmissionChannel" AS ENUM ('STANDARD', 'MULTI_BATCH', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "BillingAuthorityDecisionType" AS ENUM ('ABANDONED', 'PROCEED_WITHOUT_ALLOCATION', 'REVERSE_CHARGE', 'HEARING_REQUESTED');

-- CreateTable
CREATE TABLE "BillingAuthorityApp" (
    "id" SERIAL NOT NULL,
    "environment" "BillingAuthorityEnvironment" NOT NULL,
    "status" "BillingAuthorityAppStatus" NOT NULL DEFAULT 'ACTIVE',
    "accountingSoftwareNumber" TEXT NOT NULL,
    "itaClientId" TEXT,
    "clientSecretEncrypted" TEXT,
    "clientSecretIv" TEXT,
    "clientSecretTag" TEXT,
    "encryptionKeyId" TEXT,
    "portalOrganizationId" TEXT,
    "portalApplicationId" TEXT,
    "registeredAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAuthorityApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAuthorityConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "environment" "BillingAuthorityEnvironment" NOT NULL,
    "status" "BillingAuthorityConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "clientSoftwareKey" TEXT,
    "accessTokenEncrypted" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenTag" TEXT,
    "refreshTokenEncrypted" TEXT,
    "refreshTokenIv" TEXT,
    "refreshTokenTag" TEXT,
    "encryptionKeyId" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "oauthAuthorizedAt" TIMESTAMP(3),
    "oauthAuthorizedByUserId" INTEGER,
    "lastTokenRefreshAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAuthorityConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAuthoritySubmission" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "billingDocumentId" INTEGER NOT NULL,
    "status" "BillingAuthoritySubmissionStatus" NOT NULL DEFAULT 'READY',
    "submissionChannel" "BillingAuthoritySubmissionChannel" NOT NULL DEFAULT 'STANDARD',
    "legalSnapshotHash" TEXT,
    "authorityPayloadHash" TEXT,
    "authorityResponseHash" TEXT,
    "authoritySubmissionId" TEXT,
    "allocationNumber" TEXT,
    "isEmergencyAllocation" BOOLEAN NOT NULL DEFAULT false,
    "batchId" TEXT,
    "batchItemIndex" INTEGER,
    "heldDecisionType" "BillingAuthorityDecisionType",
    "heldDecisionReportedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAuthoritySubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAuthorityApp_environment_key" ON "BillingAuthorityApp"("environment");

-- CreateIndex
CREATE INDEX "BillingAuthorityApp_status_idx" ON "BillingAuthorityApp"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAuthorityConnection_businessId_environment_key" ON "BillingAuthorityConnection"("businessId", "environment");

-- CreateIndex
CREATE INDEX "BillingAuthorityConnection_businessId_status_idx" ON "BillingAuthorityConnection"("businessId", "status");

-- CreateIndex
CREATE INDEX "BillingAuthorityConnection_environment_status_idx" ON "BillingAuthorityConnection"("environment", "status");

-- CreateIndex
CREATE INDEX "BillingAuthorityConnection_status_refreshTokenExpiresAt_idx" ON "BillingAuthorityConnection"("status", "refreshTokenExpiresAt");

-- CreateIndex
CREATE INDEX "BillingAuthorityConnection_businessId_oauthAuthorizedAt_idx" ON "BillingAuthorityConnection"("businessId", "oauthAuthorizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAuthoritySubmission_billingDocumentId_key" ON "BillingAuthoritySubmission"("billingDocumentId");

-- CreateIndex
CREATE INDEX "BillingAuthoritySubmission_businessId_status_idx" ON "BillingAuthoritySubmission"("businessId", "status");

-- CreateIndex
CREATE INDEX "BillingAuthoritySubmission_businessId_lastAttemptAt_idx" ON "BillingAuthoritySubmission"("businessId", "lastAttemptAt");

-- CreateIndex
CREATE INDEX "BillingAuthoritySubmission_businessId_approvedAt_idx" ON "BillingAuthoritySubmission"("businessId", "approvedAt");

-- CreateIndex
CREATE INDEX "BillingAuthoritySubmission_status_lastAttemptAt_idx" ON "BillingAuthoritySubmission"("status", "lastAttemptAt");

-- CreateIndex
CREATE INDEX "BillingAuthoritySubmission_batchId_idx" ON "BillingAuthoritySubmission"("batchId");

-- AddForeignKey
ALTER TABLE "BillingAuthorityConnection" ADD CONSTRAINT "BillingAuthorityConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAuthorityConnection" ADD CONSTRAINT "BillingAuthorityConnection_oauthAuthorizedByUserId_fkey" FOREIGN KEY ("oauthAuthorizedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAuthoritySubmission" ADD CONSTRAINT "BillingAuthoritySubmission_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAuthoritySubmission" ADD CONSTRAINT "BillingAuthoritySubmission_billingDocumentId_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
