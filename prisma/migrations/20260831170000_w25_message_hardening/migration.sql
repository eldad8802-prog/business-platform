-- W2.5 — Conversation State Writer hardening: the two Message-side changes it needs.
--
-- PURELY ADDITIVE, zero backfill: one nullable column and two indexes. No table,
-- no constraint on existing data, no rewrite. Every existing row keeps
-- `clientRequestId` NULL, and NULLs never collide under Postgres unique
-- semantics, so nothing existing can conflict.

-- 1. Index Message by conversation.
--
-- The writer used to keep `unansweredInboundCount` as a mutable
-- read-modify-write counter, which made a replayed message double-count. W2.5
-- derives it from Message history instead — a persisted fact rather than an
-- accumulated one — which is idempotent by construction and self-healing.
--
-- That derivation reads Message by conversation, and "Message" carried NO index
-- beyond its primary key and the (businessId, providerMessageId) unique: even
-- the foreign key to Conversation was unsupported, so every per-conversation
-- read (the inbox thread, the pipeline context window, the Business Status
-- loaders) was a sequential scan. This index is what makes the derived count
-- cheap, and one the table should already have had.
--
-- CONCURRENTLY is deliberately not used: Prisma runs each migration inside a
-- transaction and cannot use it. "Message" is empty in Production today, so the
-- brief lock is a non-event; if that changes, build it out-of-band instead.
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
  ON "Message" ("conversationId", "createdAt");

-- 2. Send idempotency for /api/message.
--
-- The writer can be made replay-safe, but it cannot undo a DUPLICATE MESSAGE
-- ROW — two rows are two real messages, and a derived count of 2 would then be
-- correct about wrong data. `/api/message` had no guard at either end (no
-- in-flight lock on the two inbox call sites, no server-side key), so a
-- double-tap or a retry genuinely created a second message.
--
-- A caller-supplied token, enforced by a unique index, makes the send
-- exactly-once at the only layer that can enforce it. Opt-in: callers that send
-- no token are unaffected.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Message_businessId_clientRequestId_key"
  ON "Message" ("businessId", "clientRequestId");
