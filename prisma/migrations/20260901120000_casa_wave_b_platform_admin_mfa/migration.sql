-- CASA Wave B / 3.3.1 — platform-admin TOTP MFA.
--
-- EXPAND-ONLY and backward-safe:
--   * One new table. No existing table is altered, no column is dropped, no
--     data is rewritten. Code deployed before this migration is unaffected,
--     and code deployed after it works whether or not any row exists.
--   * The table starts EMPTY, which means "no administrator is enrolled".
--     Enforcement is a separate environment flag (PLATFORM_ADMIN_MFA_REQUIRED),
--     deliberately left OFF by this migration, so applying it can never lock
--     the sole production administrator out.
--   * Idempotent: IF NOT EXISTS throughout, safe to re-run.
--
-- Tenancy: this is PLATFORM-plane authentication state. There is no
-- "businessId" column, the table is never read through the tenant client, and
-- it is therefore deliberately NOT row-level-security scoped — an RLS tenant
-- predicate would be meaningless here and would only hide the row from the
-- admin path that must read it.
--
-- The TOTP seed is stored ONLY as AES-256-GCM ciphertext ("gcm_v1:..." produced
-- by lib/services/platform-admin/admin-mfa-crypto.ts under the dedicated
-- ADMIN_MFA_ENCRYPTION_KEY). There is no plaintext column by construction.
-- Recovery codes are stored ONLY as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS "PlatformAdminMfa" (
    "id"                       SERIAL       NOT NULL,
    "userId"                   INTEGER      NOT NULL,
    "secretEncrypted"          TEXT         NOT NULL,
    "encryptionKeyId"          TEXT         NOT NULL,
    "enrolledAt"               TIMESTAMP(3),
    "lastVerifiedAt"           TIMESTAMP(3),
    "lastUsedStep"             BIGINT,
    "recoveryCodeHashes"       TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "recoveryCodesGeneratedAt" TIMESTAMP(3),
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdminMfa_pkey" PRIMARY KEY ("id")
);

-- One authenticator per administrator.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformAdminMfa_userId_key"
    ON "PlatformAdminMfa"("userId");

CREATE INDEX IF NOT EXISTS "PlatformAdminMfa_enrolledAt_idx"
    ON "PlatformAdminMfa"("enrolledAt");

-- Cascade: deleting the user removes their authenticator with them. There is no
-- state worth orphaning, and a stale seed bound to a deleted account would be a
-- liability rather than an asset.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PlatformAdminMfa_userId_fkey'
    ) THEN
        ALTER TABLE "PlatformAdminMfa"
            ADD CONSTRAINT "PlatformAdminMfa_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
