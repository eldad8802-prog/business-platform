-- Transactional email foundation (migration only)
--
-- WHAT THIS ADDS
--   "TransactionalEmail": one row per transactional email Dubiz owes a recipient. It is the durable
--   event between the action that owes the email and its asynchronous delivery: the row is written in
--   the SAME transaction as that action (the first use case: account signup, kind WELCOME), and a
--   delivery worker claims it, sends it through the provider with a stable idempotency key, and records
--   the outcome. Generic by design — a new kind is a code-registry entry, never a migration:
--     * kind is free TEXT (format-checked, not a closed list);
--     * dedupeKey is the idempotency key, unique across the table (for WELCOME: welcome:user:<userId>);
--     * payload is the template's parameters (a JSON object), captured when the row is written.
--   Recipient and content never change after insert; only the delivery columns move.
--
-- WHO MAY DO WHAT (FORCE RLS; every role but the table owner is subject to the policies)
--   app_auth   — the signup / delivery plane:
--                SELECT; INSERT on the creation columns; UPDATE on the delivery columns only; the id
--                sequence. No DELETE. Its INSERT must prove, in the database, that the row's userId
--                (when present) belongs to the row's businessId — an email for one business's user can
--                never be filed under another business.
--   app_runtime — the tenant plane, for account erasure ONLY:
--                DELETE, and SELECT on (id, businessId) and nothing else — never toEmail, payload or any
--                delivery column; no INSERT, no UPDATE. Both bound by RLS to app.current_business_id, so
--                the erasure job deletes exactly the rows of the business it is erasing and no other.
--   PUBLIC     — nothing.
--   The owner's default privileges would otherwise hand app_runtime INSERT / SELECT / UPDATE / DELETE on
--   the whole table (20260908200000_auth_session_privilege_contract); they are revoked first and the
--   privileges above are named explicitly.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   - no closed list of kinds, no provider-specific column beyond provider / providerMessageId;
--   - no DELETE for app_auth, no catch-all policy, no policy without a FOR clause;
--   - no backfill: existing users get no row, so no welcome is ever sent retroactively.
--
-- Additive only: one table, its sequence, four indexes, five policies, explicit privileges.

CREATE TABLE "TransactionalEmail" (
  "id" SERIAL NOT NULL,
  "kind" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "userId" INTEGER,
  "businessId" INTEGER NOT NULL,
  "toEmail" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "locale" TEXT NOT NULL DEFAULT 'he',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastErrorCode" TEXT,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),

  CONSTRAINT "TransactionalEmail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TransactionalEmail_kind" CHECK ("kind" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "TransactionalEmail_dedupe_key" CHECK (char_length("dedupeKey") BETWEEN 1 AND 200),
  CONSTRAINT "TransactionalEmail_to_email" CHECK (
    char_length("toEmail") BETWEEN 3 AND 320 AND position('@' IN "toEmail") > 1
  ),
  CONSTRAINT "TransactionalEmail_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "TransactionalEmail_locale" CHECK ("locale" ~ '^[a-z]{2}$'),
  CONSTRAINT "TransactionalEmail_status" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'EXPIRED')),
  CONSTRAINT "TransactionalEmail_attempts" CHECK ("attempts" >= 0),
  CONSTRAINT "TransactionalEmail_sent_has_time" CHECK ("status" <> 'SENT' OR "sentAt" IS NOT NULL),
  CONSTRAINT "TransactionalEmail_delivery_text" CHECK (
    ("lastErrorCode" IS NULL OR char_length("lastErrorCode") <= 120)
    AND ("provider" IS NULL OR char_length("provider") <= 40)
    AND ("providerMessageId" IS NULL OR char_length("providerMessageId") <= 200)
  )
);

-- The idempotency key: one row per owed email, across every kind.
CREATE UNIQUE INDEX "TransactionalEmail_dedupeKey_key" ON "TransactionalEmail"("dedupeKey");
-- The delivery worker's scan: due rows by status.
CREATE INDEX "TransactionalEmail_status_nextAttemptAt_idx" ON "TransactionalEmail"("status", "nextAttemptAt");
CREATE INDEX "TransactionalEmail_userId_idx" ON "TransactionalEmail"("userId");
-- Tenant-led: the erasure delete and the runtime policies key on it.
CREATE INDEX "TransactionalEmail_businessId_idx" ON "TransactionalEmail"("businessId");

ALTER TABLE "TransactionalEmail" ADD CONSTRAINT "TransactionalEmail_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionalEmail" ADD CONSTRAINT "TransactionalEmail_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "TransactionalEmail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransactionalEmail" FORCE ROW LEVEL SECURITY;

-- Signup / delivery plane. It runs before any tenant context exists (inside the signup transaction,
-- and in the cross-tenant delivery worker), so its reach is set by its column privileges, not a GUC.
CREATE POLICY transactional_email_auth_select ON "TransactionalEmail" FOR SELECT TO app_auth
  USING (true);

-- The tenant binding: a row naming a user must name THAT user's business.
CREATE POLICY transactional_email_auth_insert ON "TransactionalEmail" FOR INSERT TO app_auth
  WITH CHECK (
    "userId" IS NULL
    OR EXISTS (
      SELECT 1 FROM "User" u
      WHERE u."id" = "TransactionalEmail"."userId" AND u."businessId" = "TransactionalEmail"."businessId"
    )
  );

CREATE POLICY transactional_email_auth_update ON "TransactionalEmail" FOR UPDATE TO app_auth
  USING (true)
  WITH CHECK (true);

-- Tenant plane: account erasure only, and only inside the tenant being erased.
CREATE POLICY transactional_email_runtime_select ON "TransactionalEmail" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY transactional_email_runtime_delete ON "TransactionalEmail" FOR DELETE TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges, named explicitly ───────────────────────────────────────────────────────────────

REVOKE ALL ON "TransactionalEmail" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "TransactionalEmail_id_seq" FROM PUBLIC;

REVOKE ALL ON "TransactionalEmail" FROM app_runtime;
REVOKE ALL ON SEQUENCE "TransactionalEmail_id_seq" FROM app_runtime;
GRANT SELECT ("id", "businessId") ON "TransactionalEmail" TO app_runtime;
GRANT DELETE ON "TransactionalEmail" TO app_runtime;

REVOKE ALL ON "TransactionalEmail" FROM app_auth;
REVOKE ALL ON SEQUENCE "TransactionalEmail_id_seq" FROM app_auth;
GRANT SELECT ON "TransactionalEmail" TO app_auth;
GRANT INSERT ("kind", "dedupeKey", "userId", "businessId", "toEmail", "payload", "locale", "status",
              "nextAttemptAt", "expiresAt", "createdAt", "updatedAt")
  ON "TransactionalEmail" TO app_auth;
GRANT UPDATE ("status", "attempts", "nextAttemptAt", "lastErrorCode", "provider", "providerMessageId",
              "sentAt", "updatedAt")
  ON "TransactionalEmail" TO app_auth;
GRANT USAGE ON SEQUENCE "TransactionalEmail_id_seq" TO app_auth;
