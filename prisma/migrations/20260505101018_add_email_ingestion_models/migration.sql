-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('gmail');

-- CreateEnum
CREATE TYPE "EmailConnectionStatus" AS ENUM ('connected', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "EmailAttachmentImportStatus" AS ENUM ('imported', 'skipped_duplicate', 'failed');

-- CreateTable
CREATE TABLE "EmailConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "status" "EmailConnectionStatus" NOT NULL DEFAULT 'connected',
    "emailAddress" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncCursor" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" SERIAL NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenType" TEXT,
    "encryptionKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachmentImport" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT,
    "attachmentId" TEXT NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "fromEmail" TEXT,
    "subject" TEXT,
    "sentAt" TIMESTAMP(3),
    "contentHashSha256" TEXT NOT NULL,
    "status" "EmailAttachmentImportStatus" NOT NULL,
    "error" TEXT,
    "documentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAttachmentImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailConnection_businessId_provider_idx" ON "EmailConnection"("businessId", "provider");

-- CreateIndex
CREATE INDEX "EmailConnection_status_idx" ON "EmailConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_businessId_provider_emailAddress_key" ON "EmailConnection"("businessId", "provider", "emailAddress");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_connectionId_key" ON "OAuthToken"("connectionId");

-- CreateIndex
CREATE INDEX "OAuthToken_expiresAt_idx" ON "OAuthToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachmentImport_documentId_key" ON "EmailAttachmentImport"("documentId");

-- CreateIndex
CREATE INDEX "EmailAttachmentImport_businessId_createdAt_idx" ON "EmailAttachmentImport"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailAttachmentImport_connectionId_createdAt_idx" ON "EmailAttachmentImport"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailAttachmentImport_documentId_idx" ON "EmailAttachmentImport"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachmentImport_businessId_provider_messageId_attachm_key" ON "EmailAttachmentImport"("businessId", "provider", "messageId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachmentImport_businessId_contentHashSha256_key" ON "EmailAttachmentImport"("businessId", "contentHashSha256");

-- AddForeignKey
ALTER TABLE "EmailConnection" ADD CONSTRAINT "EmailConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "EmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachmentImport" ADD CONSTRAINT "EmailAttachmentImport_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachmentImport" ADD CONSTRAINT "EmailAttachmentImport_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "EmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachmentImport" ADD CONSTRAINT "EmailAttachmentImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
