-- Inbound email document ingestion — inert foundation.
--
-- WHAT THIS IS FOR
--
-- A business owner forwards supplier invoices from their own mailbox to a
-- Dubiz address, and the attachments become Documents through the pipeline that
-- already exists. This migration creates the three tables that pipeline will
-- land in. It creates nothing else.
--
-- INERT. Nothing reads or writes these tables. There is no route, no service
-- consumer, no UI and no scheduled job. The feature flag INBOUND_EMAIL_ENABLED
-- defaults to off and fails closed when absent, so no owner can reach this
-- surface even by accident. The runtime knows exactly as much about inbound
-- email after this migration as before it.
--
-- EXPAND-ONLY. Three new tables, three new enums, their indexes, their foreign
-- keys, their policies and their grants. No existing column is altered or
-- dropped, no existing table is touched, and no row is written. The only
-- reference into existing data is a foreign key FROM the new attachment ledger
-- TO Document, which adds a constraint to the new table and changes nothing
-- about Document itself.
--
-- WHAT IS DELIBERATELY ABSENT
--
--   * no message body, no header set, no raw MIME column. The product of this
--     pipeline is the DOCUMENT; Dubiz is not becoming a mailbox. The raw
--     message lives in object storage only as long as processing needs it
--   * no plaintext address. `tokenHash` is the lookup key, so an address can
--     route without ever being at rest here
--   * no path to an approved FinancialRecord. An inbound document reaches the
--     review queue and stops, exactly like an uploaded one
--
-- THE ADDRESS IS NOT A CREDENTIAL
--
-- Possessing one lets a stranger put a document in front of one business's
-- review queue. It authenticates nobody, grants no read access, and cannot
-- reach another tenant. The design assumes it leaks eventually, which is why
-- revocation and rotation are in the model rather than deferred.

-- CreateEnum
CREATE TYPE "InboundEmailAddressStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "InboundEmailMessageStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'QUARANTINED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InboundEmailAuthVerdict" AS ENUM ('PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "InboundEmailAddress" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "localPartPreview" TEXT NOT NULL,
    "localPartEncrypted" TEXT NOT NULL,
    "localPartIv" TEXT NOT NULL,
    "localPartTag" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "label" TEXT,
    "status" "InboundEmailAddressStatus" NOT NULL DEFAULT 'ACTIVE',
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastReceivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" INTEGER,

    CONSTRAINT "InboundEmailAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmailMessage" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "addressId" INTEGER NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "status" "InboundEmailMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "fromEmail" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3),
    "spfVerdict" "InboundEmailAuthVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "dkimVerdict" "InboundEmailAuthVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "dmarcVerdict" "InboundEmailAuthVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "spamVerdict" "InboundEmailAuthVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "virusVerdict" "InboundEmailAuthVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "rawObjectKey" TEXT,
    "rawDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundEmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmailAttachmentImport" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "contentHashSha256" TEXT NOT NULL,
    "status" "EmailAttachmentImportStatus" NOT NULL,
    "error" TEXT,
    "documentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEmailAttachmentImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAddress_tokenHash_key" ON "InboundEmailAddress"("tokenHash");

-- CreateIndex
CREATE INDEX "InboundEmailAddress_businessId_status_idx" ON "InboundEmailAddress"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAddress_businessId_id_key" ON "InboundEmailAddress"("businessId", "id");

-- CreateIndex
CREATE INDEX "InboundEmailMessage_businessId_createdAt_idx" ON "InboundEmailMessage"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InboundEmailMessage_status_createdAt_idx" ON "InboundEmailMessage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailMessage_businessId_providerMessageId_key" ON "InboundEmailMessage"("businessId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailMessage_businessId_id_key" ON "InboundEmailMessage"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAttachmentImport_documentId_key" ON "InboundEmailAttachmentImport"("documentId");

-- CreateIndex
CREATE INDEX "InboundEmailAttachmentImport_businessId_messageId_idx" ON "InboundEmailAttachmentImport"("businessId", "messageId");

-- CreateIndex
CREATE INDEX "InboundEmailAttachmentImport_documentId_idx" ON "InboundEmailAttachmentImport"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAttachmentImport_businessId_contentHashSha256_key" ON "InboundEmailAttachmentImport"("businessId", "contentHashSha256");

-- AddForeignKey
ALTER TABLE "InboundEmailAddress" ADD CONSTRAINT "InboundEmailAddress_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailMessage" ADD CONSTRAINT "InboundEmailMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailMessage" ADD CONSTRAINT "InboundEmailMessage_businessId_addressId_fkey" FOREIGN KEY ("businessId", "addressId") REFERENCES "InboundEmailAddress"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailAttachmentImport" ADD CONSTRAINT "InboundEmailAttachmentImport_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailAttachmentImport" ADD CONSTRAINT "InboundEmailAttachmentImport_businessId_messageId_fkey" FOREIGN KEY ("businessId", "messageId") REFERENCES "InboundEmailMessage"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailAttachmentImport" ADD CONSTRAINT "InboundEmailAttachmentImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Row-level security ───────────────────────────────────────────────────────
--
-- All three tables are tenant-owned business data, so they take the tenant-data
-- shape used by every P7 wave: ENABLE + FORCE + a policy on the
-- transaction-local GUC.
--
-- Fail-closed by construction: with no GUC set, current_setting(..., true)
-- returns '', NULLIF yields NULL, and the comparison is NULL — so no row
-- qualifies. INERT under an owner/BYPASSRLS runtime; enforcing under a
-- least-privilege runtime role.
--
-- Each table carries its own "businessId" and gets its own policy rather than
-- inheriting ownership through a foreign key. Deriving the child's tenant from
-- its parent would leave the child unprotected the moment someone queried it
-- directly — the same reasoning AD-2A applied to Message.

ALTER TABLE "InboundEmailAddress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmailAddress" FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_addr_tenant ON "InboundEmailAddress"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InboundEmailMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmailMessage" FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_msg_tenant ON "InboundEmailMessage"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InboundEmailAttachmentImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmailAttachmentImport" FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_att_tenant ON "InboundEmailAttachmentImport"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Granted explicitly rather than inherited from a default ACL. The notification
-- migration relied on the Production default ACL and, measured on Preview which
-- has no such rule, its two tables arrived with the tenant runtime holding
-- nothing at all. Naming the grants here means every environment reaches the
-- same effective privileges from the same history.
--
-- Guarded on the role existing, so this migration is a clean no-op on a database
-- that has no app_runtime — a fresh developer database, or CI.
--
-- DELETE is granted because two real consumers need it: the retention sweep that
-- clears a processed message's raw-object pointer and, eventually, account
-- erasure. A privilege with no consumer would be residue; a missing privilege
-- with a consumer would be an outage.
--
-- No admin policy and no admin grant. Nothing in platform-admin reads these
-- tables, and granting a cross-tenant read "for symmetry" would create an
-- access path that nothing asks for.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailAddress" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailMessage" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailAttachmentImport" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InboundEmailAddress_id_seq" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InboundEmailMessage_id_seq" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InboundEmailAttachmentImport_id_seq" TO app_runtime;
  END IF;
END
$do$;
