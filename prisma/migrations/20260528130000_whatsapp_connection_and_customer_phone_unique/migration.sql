-- =============================================================================
-- 20260528130000_whatsapp_connection_and_customer_phone_unique
--
-- Bot-MVP-1 schema foundation:
--   • per-business WhatsApp connection model (replaces env-map routing)
--   • outbound Message send-status tracking
--   • canonical Customer.phone format + (businessId, phone) uniqueness
--
-- This migration was generated as a committed artifact and is intended to be
-- applied via `prisma migrate deploy` against the target database. Do NOT run
-- `prisma migrate dev` against any shared/production DB.
--
-- Pre-deploy verification:
--   `node scripts/audit-customer-phones.mjs` ran 2026-05-28 and returned
--   Section A = 0 groups, Section B = 0 groups, Customer table empty.
--   The Customer.phone UPDATE below is therefore a verified no-op.
-- =============================================================================

-- ---------- enums ----------------------------------------------------------

CREATE TYPE "WhatsAppConnectionStatus" AS ENUM (
  'CONNECTED',
  'DISCONNECTED',
  'REVOKED',
  'REVOKED_BY_META',
  'ERROR'
);

CREATE TYPE "MessageSendStatus" AS ENUM (
  'PENDING',
  'SENT',
  'FAILED'
);

-- ---------- WhatsAppConnection table --------------------------------------

CREATE TABLE "WhatsAppConnection" (
  "id"                   SERIAL                       NOT NULL,
  "businessId"           INTEGER                      NOT NULL,
  "phoneNumberId"        TEXT                         NOT NULL,
  "displayPhoneNumber"   TEXT                         NOT NULL,
  "wabaId"               TEXT                         NOT NULL,
  "accessTokenEncrypted" TEXT                         NOT NULL,
  "accessTokenIv"        TEXT                         NOT NULL,
  "accessTokenTag"       TEXT                         NOT NULL,
  "status"               "WhatsAppConnectionStatus"   NOT NULL DEFAULT 'CONNECTED',
  "lastVerifiedAt"       TIMESTAMP(3),
  "lastErrorAt"          TIMESTAMP(3),
  "lastErrorCode"        TEXT,
  "lastErrorMessage"     TEXT,
  "createdAt"            TIMESTAMP(3)                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)                 NOT NULL,

  CONSTRAINT "WhatsAppConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppConnection_businessId_key"
  ON "WhatsAppConnection"("businessId");

CREATE UNIQUE INDEX "WhatsAppConnection_phoneNumberId_key"
  ON "WhatsAppConnection"("phoneNumberId");

CREATE INDEX "WhatsAppConnection_status_idx"
  ON "WhatsAppConnection"("status");

ALTER TABLE "WhatsAppConnection"
  ADD CONSTRAINT "WhatsAppConnection_businessId_fkey"
  FOREIGN KEY ("businessId")
  REFERENCES "Business"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- ---------- Message send-status columns (all nullable, no backfill) --------

ALTER TABLE "Message"
  ADD COLUMN "sendStatus"        "MessageSendStatus",
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "sendErrorCode"     TEXT,
  ADD COLUMN "sendErrorMessage"  TEXT,
  ADD COLUMN "sendAttemptedAt"   TIMESTAMP(3);

-- ---------- Customer phone canonicalization + unique --------------------------
--
-- Canonical rules (mirror `normalizeCustomerPhone()` in
-- `lib/services/integrations/whatsapp/phone.ts`):
--   • strip every non-digit
--   • drop leading "00" if present
--   • leading "972"  → keep as-is
--   • leading "0"    → replace with "972"
--   • else            → keep stripped digits
--   • result < 8 digits → leave as NULL (caller must treat as missing)
--
-- The pre-deploy audit (2026-05-28) verified an empty Customer table so this
-- UPDATE touches zero rows. It remains here so the migration is correct on
-- any future re-bootstrap from a non-empty fixture.

UPDATE "Customer"
SET "phone" = CASE
  WHEN length(regexp_replace(
         CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
              THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
              ELSE regexp_replace("phone", '\D', '', 'g')
         END, '\D', '', 'g')) < 8
    THEN NULL
  WHEN (CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
             THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
             ELSE regexp_replace("phone", '\D', '', 'g')
        END) ~ '^972'
    THEN (CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
                THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
                ELSE regexp_replace("phone", '\D', '', 'g')
          END)
  WHEN (CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
             THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
             ELSE regexp_replace("phone", '\D', '', 'g')
        END) ~ '^0'
    THEN '972' || substring(
         CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
              THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
              ELSE regexp_replace("phone", '\D', '', 'g')
         END from 2)
  ELSE (CASE WHEN regexp_replace("phone", '\D', '', 'g') LIKE '00%'
              THEN substring(regexp_replace("phone", '\D', '', 'g') from 3)
              ELSE regexp_replace("phone", '\D', '', 'g')
        END)
END
WHERE "phone" IS NOT NULL;

-- Postgres treats NULLs as distinct in unique constraints, so multiple
-- no-phone Customers per business remain allowed.
CREATE UNIQUE INDEX "Customer_businessId_phone_key"
  ON "Customer"("businessId", "phone");
