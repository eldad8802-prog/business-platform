-- Inbound email — authorised senders, their verification challenges, and the
-- provenance a message needs in order to be judged later.
--
-- STILL INERT. Nothing reads or writes any of this. There is no route, no
-- service, no worker, no MIME parser and no authorisation evaluator.
-- INBOUND_EMAIL_ENABLED defaults to off and fails closed when absent. The
-- runtime knows exactly as much about inbound email after this migration as
-- before it.
--
-- WHY THESE TABLES EXIST
--
-- Receiving a message at a tenant's address says the address was forwarded to.
-- It says nothing about who sent it, and `From:` is trivially forged. So the
-- question "may this sender put a document in front of this business" needs an
-- answer that is written down BEFORE the message arrives. That is the authorised
-- sender list, and a claim on it is only worth anything once the holder of the
-- claimed mailbox has answered a challenge sent to it.
--
-- WHAT IS DELIBERATELY ABSENT
--
--   * no plaintext challenge column, and there never may be one. Only the hash
--     is stored, for the same reason a password is not kept: reading this table
--     must not confer the ability to complete somebody else's verification
--   * no enum member that names a matching mechanism as authoritative. The
--     outcome and the thing that matched are separate columns, because the
--     forwarding matcher has not been measured against real deliveries yet
--   * no Reply-To, no Return-Path, no Received chain, no header set, no body,
--     no raw MIME. The product of this pipeline is the Document
--
-- EXPAND-ONLY. Two new tables, two new enums, new nullable columns on existing
-- inbound tables, and one column RENAME that preserves its values. Nothing is
-- dropped, nothing is narrowed, no row is written, and no table outside the
-- inbound family is touched.

-- CreateEnum
CREATE TYPE "InboundEmailSenderStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "InboundEmailAuthorizationOutcome" AS ENUM ('NOT_EVALUATED', 'AUTHORIZED', 'UNAUTHORIZED', 'INDETERMINATE');

-- ── The rename, done as a rename ─────────────────────────────────────────────
--
-- `prisma migrate diff` writes this pair as DROP COLUMN + ADD COLUMN, which is
-- silent data loss: every existing timestamp would be discarded and the column
-- would come back full of NULLs. ALTER TABLE ... RENAME COLUMN keeps the values,
-- the type and the nullability, and is a catalogue-only operation that does not
-- rewrite the table.
--
-- The name changed because the old one made a claim the column cannot support.
-- `verifiedAt` read as though a message arriving verified somebody. It does not:
-- it records only that forwarding reached us. Authorisation of a SENDER is a
-- different question, answered per message against the table created below.
ALTER TABLE "InboundEmailAddress" RENAME COLUMN "verifiedAt" TO "firstMessageAt";

-- AlterTable
--
-- All nullable, or defaulted. `authorizationOutcome` defaults to NOT_EVALUATED,
-- which is the honest state for every row this migration can produce: no
-- evaluator exists, so nothing has been evaluated.
ALTER TABLE "InboundEmailMessage" ADD COLUMN     "authorizationMatchedSource" TEXT,
ADD COLUMN     "authorizationMatchedValue" TEXT,
ADD COLUMN     "authorizationOutcome" "InboundEmailAuthorizationOutcome" NOT NULL DEFAULT 'NOT_EVALUATED',
ADD COLUMN     "authorizedSenderId" INTEGER,
ADD COLUMN     "messageIdHeader" TEXT;

-- AlterTable
--
-- Nullable rather than NOT NULL DEFAULT 0: a default would invent a position for
-- any row written before the parser recorded one, and a confidently wrong 0 is
-- worse than an absent answer.
ALTER TABLE "InboundEmailAttachmentImport" ADD COLUMN     "attachmentIndex" INTEGER;

-- CreateTable
CREATE TABLE "InboundEmailAuthorizedSender" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "status" "InboundEmailSenderStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" INTEGER,

    CONSTRAINT "InboundEmailAuthorizedSender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmailSenderChallenge" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "authorizedSenderId" INTEGER NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEmailSenderChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEmailAuthorizedSender_businessId_status_idx" ON "InboundEmailAuthorizedSender"("businessId", "status");

-- CreateIndex
--
-- Per tenant, not global. The same bookkeeper's address may legitimately be
-- listed by several businesses.
CREATE UNIQUE INDEX "InboundEmailAuthorizedSender_businessId_normalizedEmail_key" ON "InboundEmailAuthorizedSender"("businessId", "normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAuthorizedSender_businessId_id_key" ON "InboundEmailAuthorizedSender"("businessId", "id");

-- CreateIndex
CREATE INDEX "InboundEmailSenderChallenge_businessId_authorizedSenderId_idx" ON "InboundEmailSenderChallenge"("businessId", "authorizedSenderId");

-- CreateIndex
CREATE INDEX "InboundEmailSenderChallenge_expiresAt_idx" ON "InboundEmailSenderChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "InboundEmailMessage_authorizedSenderId_idx" ON "InboundEmailMessage"("authorizedSenderId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailAttachmentImport_businessId_messageId_attachmen_key" ON "InboundEmailAttachmentImport"("businessId", "messageId", "attachmentIndex");

-- AddForeignKey
--
-- Plain reference to the sender's id, NOT the tenant composite. Two reasons.
-- Removing a sender must not cascade away the provenance of the messages it
-- explains, and a composite whose tenant column is NOT NULL cannot be SET NULL.
-- The tenant boundary here is the row's own businessId under forced row-level
-- security, which is the same argument the Document reference in this family
-- already rests on.
ALTER TABLE "InboundEmailMessage" ADD CONSTRAINT "InboundEmailMessage_authorizedSenderId_fkey" FOREIGN KEY ("authorizedSenderId") REFERENCES "InboundEmailAuthorizedSender"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailAuthorizedSender" ADD CONSTRAINT "InboundEmailAuthorizedSender_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailSenderChallenge" ADD CONSTRAINT "InboundEmailSenderChallenge_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- Composite, so a challenge cannot reference a sender in another tenant. CASCADE
-- is correct here and only here: a challenge is subordinate to the claim it
-- verifies and means nothing once that claim is gone.
ALTER TABLE "InboundEmailSenderChallenge" ADD CONSTRAINT "InboundEmailSenderChallenge_businessId_authorizedSenderId_fkey" FOREIGN KEY ("businessId", "authorizedSenderId") REFERENCES "InboundEmailAuthorizedSender"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- Same shape as the three tables of the foundation migration: ENABLE and FORCE,
-- so the policy applies to the table owner as well, and a single policy keyed on
-- the tenant GUC for both reading and writing.

ALTER TABLE "InboundEmailAuthorizedSender" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmailAuthorizedSender" FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_sender_tenant ON "InboundEmailAuthorizedSender"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InboundEmailSenderChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmailSenderChallenge" FORCE ROW LEVEL SECURITY;

CREATE POLICY inbound_challenge_tenant ON "InboundEmailSenderChallenge"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Named explicitly rather than inherited from a default ACL, for the reason the
-- foundation migration records: a migration that relied on Production's default
-- rule arrived on Preview with the tenant runtime holding nothing at all.
--
-- Guarded on the role existing, so this is a clean no-op on a database with no
-- app_runtime — a fresh developer database, or CI.
--
-- DELETE is granted for the same two consumers as the foundation tables: the
-- expiry sweep that clears spent challenges, and account erasure. No admin
-- policy and no admin grant: nothing in platform-admin reads these tables.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailAuthorizedSender" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailSenderChallenge" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InboundEmailAuthorizedSender_id_seq" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InboundEmailSenderChallenge_id_seq" TO app_runtime;
  END IF;
END
$do$;
