-- ============================================================================================================
-- 20261024090000_platform_admin_a1 — Admin Control Center A1: the platform-admin READ plane, and passkeys for
-- the admin step-up. Owner-approved direction (2026-10-22); applying it is a separate owner gate.
--
-- WHY. In Production `app_admin` (NOLOGIN group, 20260825090000) has no LOGIN member and no privilege on the
-- tables the admin console reads (preflight run 37138112739). The console therefore either fails
-- (ADMIN_DATABASE_URL is not configured in Vercel Production) or reads through the tenant runtime with no tenant
-- context, where FORCE RLS returns zero rows without an error (runtime-RLS proof run 36791331075, noContext 5/5).
--
-- 1. READ PLANE. `app_admin` gets SELECT on exactly the columns the admin services read — never a password,
--    a session secret, an OAuth token, document content (fileUrl, ocrText), money amounts or a customer.
--    Cross-tenant visibility rides the ADDITIVE `p7adm_read` policies (FOR SELECT TO app_admin USING (true));
--    the one RLS table here without one (BusinessProfile) gets it. No tenant policy is altered, FORCE RLS is
--    untouched, nothing is dropped, and `app_admin` receives no INSERT / UPDATE / DELETE anywhere: the admin
--    audit append stays on the runtime's reviewed SELECT+INSERT (20261003090000).
--    Table-level SELECT on "User" and "AuthSession" is revoked first (it exists in Preview from the per-
--    environment W2 artifact), so every environment ends in the same column-scoped state for those two.
-- 2. PASSKEYS. "PlatformAdminPasskey": WebAuthn credentials an MFA-elevated platform admin registers as a
--    second way to step up (Face ID / fingerprint). Public keys only — a passkey's private key never leaves the
--    authenticator. Authentication material, so it lives on the AUTH plane: `app_auth` alone may read, add and
--    change it (no DELETE — removal is revokedAt); the tenant runtime and the admin read plane get nothing.
--    The owner's DEFAULT PRIVILEGES hand a new table to the runtime wholesale, so that is taken back first.
--
-- Expand-only for everything that already exists. Every role statement is guarded on the role existing.
-- ============================================================================================================

-- ── 1. Admin read plane ────────────────────────────────────────────────────────────────────────────────────

-- The one RLS'd table the console reads that has no admin read policy yet (onboarding state).
-- Plain statements on purpose: the RLS contract tooling (.ad2a) reads policies from top-level DDL. app_admin
-- exists in every environment since 20260825090000 (preflight check 4 proves it before apply).
DROP POLICY IF EXISTS p7adm_read ON "BusinessProfile";
CREATE POLICY p7adm_read ON "BusinessProfile"
  FOR SELECT TO app_admin
  USING (true);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    -- Schema visibility only; CREATE stays denied.
    GRANT USAGE ON SCHEMA public TO app_admin;

    -- Secret-bearing tables: column scope is the WHOLE grant (password / tokenVersion, secretHash).
    REVOKE SELECT ON "User" FROM app_admin;
    REVOKE SELECT ON "AuthSession" FROM app_admin;

    GRANT SELECT ("id", "name", "archivedAt", "deletionRequestedAt", "deletedAt", "createdAt")
      ON "Business" TO app_admin;
    GRANT SELECT ("id", "email", "name", "businessId", "lastLoginAt", "loginCount", "emailVerifiedAt", "createdAt")
      ON "User" TO app_admin;
    GRANT SELECT ("id", "businessId", "onboardingCompletedAt", "createdAt")
      ON "BusinessProfile" TO app_admin;
    GRANT SELECT ("userId", "lastUsedAt")
      ON "AuthSession" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "emailAddress", "lastSyncedAt", "createdAt")
      ON "EmailConnection" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "source", "createdAt")
      ON "Document" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "pdfRenderStatus", "createdAt")
      ON "BillingDocument" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "lastMessageAt", "unansweredInboundCount", "createdAt")
      ON "Conversation" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "createdAt")
      ON "ContentRun" TO app_admin;
    GRANT SELECT ("id", "businessId", "status", "createdAt")
      ON "WhatsAppAttachmentImport" TO app_admin;

    -- Telemetry and the admin's own audit trail: read whole (no RLS on either; no secret columns).
    GRANT SELECT ON "ProductUsageEvent" TO app_admin;
    GRANT SELECT ON "PlatformAuditEvent" TO app_admin;
  END IF;
END
$do$;

-- ── 2. Platform-admin passkeys (auth plane) ────────────────────────────────────────────────────────────────

CREATE TABLE "PlatformAdminPasskey" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signCount" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL,
    "lastChallengeIssuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformAdminPasskey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdminPasskey_credentialId_key" ON "PlatformAdminPasskey"("credentialId");
CREATE INDEX "PlatformAdminPasskey_userId_revokedAt_idx" ON "PlatformAdminPasskey"("userId", "revokedAt");

ALTER TABLE "PlatformAdminPasskey" ADD CONSTRAINT "PlatformAdminPasskey_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformAdminPasskey" ADD CONSTRAINT "PlatformAdminPasskey_label_shape"
  CHECK (char_length("label") BETWEEN 1 AND 60);
ALTER TABLE "PlatformAdminPasskey" ADD CONSTRAINT "PlatformAdminPasskey_credentialId_shape"
  CHECK (char_length("credentialId") BETWEEN 16 AND 1024);
ALTER TABLE "PlatformAdminPasskey" ADD CONSTRAINT "PlatformAdminPasskey_signCount_nonnegative"
  CHECK ("signCount" >= 0);
ALTER TABLE "PlatformAdminPasskey" ADD CONSTRAINT "PlatformAdminPasskey_deviceType_shape"
  CHECK ("deviceType" IS NULL OR "deviceType" IN ('singleDevice', 'multiDevice'));

-- Start from nothing, then grant the auth plane exactly read / add / change-the-mutable-columns.
REVOKE ALL ON "PlatformAdminPasskey" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "PlatformAdminPasskey_id_seq" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "PlatformAdminPasskey" FROM app_runtime;
    REVOKE ALL ON SEQUENCE "PlatformAdminPasskey_id_seq" FROM app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    REVOKE ALL ON "PlatformAdminPasskey" FROM app_admin;
    REVOKE ALL ON SEQUENCE "PlatformAdminPasskey_id_seq" FROM app_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    GRANT SELECT, INSERT ON "PlatformAdminPasskey" TO app_auth;
    GRANT UPDATE ("signCount", "lastUsedAt", "lastChallengeIssuedAt", "label", "revokedAt")
      ON "PlatformAdminPasskey" TO app_auth;
    GRANT USAGE, SELECT ON SEQUENCE "PlatformAdminPasskey_id_seq" TO app_auth;
  END IF;
END
$do$;
