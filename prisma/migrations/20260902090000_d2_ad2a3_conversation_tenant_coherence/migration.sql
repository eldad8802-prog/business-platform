-- D2 / ACCOUNT-DELETION-2A.3 — structural tenant coherence for the destructive
-- Conversation subgraph.
--
-- WHY THIS EXISTS
-- A PostgreSQL FK cascade is executed by an internal system trigger. It is NOT
-- subject to RLS policies and NOT subject to the invoking role's table privileges.
-- So RLS on Message/ReplySuggestion does not bound what a Conversation DELETE can
-- reach: if a Message row ever carried businessId=B while hanging off a
-- Conversation owned by A, deleting A's conversation would destroy B's row.
--
-- Until now the only thing preventing that was application discipline (the API
-- route re-reads the Conversation with `where: { id, businessId }`). This migration
-- moves the invariant into the relational layer, where no application bug, AI
-- output, webhook replay or raw statement can violate it:
--
--   Message.conversationId        = Conversation.id
--     ==> Message.businessId        = Conversation.businessId
--   ReplySuggestion.conversationId = Conversation.id
--     ==> ReplySuggestion.businessId = Conversation.businessId
--
-- MessageAnalysis deliberately gets NOTHING here. It has no businessId and owns
-- exclusively through Message.messageId (@unique, ON DELETE CASCADE). Its ownership
-- is therefore derived, and adding a businessId would create a second, divergeable
-- source of truth — a regression, not a hardening.
--
-- NULL SEMANTICS (why MATCH FULL is not needed)
-- A composite FK defaults to MATCH SIMPLE, which skips the check entirely when ANY
-- referencing column is NULL. That would be a real bypass — a row with businessId
-- NULL could attach to any tenant's Conversation. It does not apply here because
-- Message.businessId, Message.conversationId, ReplySuggestion.businessId and
-- ReplySuggestion.conversationId are all NOT NULL, so no row can present a partial
-- key. Those NOT NULLs are load-bearing security properties and are pinned by
-- scripts/ci/conversation-coherence-guard.sh.
--
-- VALIDATION STRATEGY: direct, not NOT VALID (see the closure report, Phase 8).
-- Prisma executes a migration file inside ONE transaction, so ADD CONSTRAINT ...
-- NOT VALID followed by VALIDATE CONSTRAINT in the same file would hold the same
-- ShareRowExclusiveLock for the same duration and buy exactly nothing. The only way
-- NOT VALID helps is as two separately committed migrations — which would ship a
-- window where the constraint is present but unenforced. For a migration whose
-- entire purpose is enforcement, that window is the defect.
--
-- LOCKS: this is low, bounded lock risk — NOT "no locks". Every statement below
-- takes a lock; see the closure report for the operation-by-operation profile.

-- The composite parent key. `Conversation.id` is already unique on its own; this
-- constraint exists because PostgreSQL requires the REFERENCED column list of a
-- foreign key to be unique, so this index is the mechanism that makes
-- (id, businessId) addressable as a tenant-coherent relational target.
CREATE UNIQUE INDEX "Conversation_id_businessId_key" ON "Conversation"("id", "businessId");

-- Cascade + FK support on the referencing side. ReplySuggestion previously had no
-- index on conversationId at all.
CREATE INDEX "ReplySuggestion_conversationId_businessId_idx" ON "ReplySuggestion"("conversationId", "businessId");

-- Replace the single-column FKs with tenant-coherent composite FKs. The drop and
-- the add are in the same transaction, so there is no committed moment in which the
-- child tables are unconstrained. Delete/update semantics are preserved exactly
-- (CASCADE/CASCADE) — this migration changes WHAT may be referenced, never what
-- happens when the parent goes away.
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_fkey";
ALTER TABLE "ReplySuggestion" DROP CONSTRAINT "ReplySuggestion_conversationId_fkey";

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_businessId_fkey"
  FOREIGN KEY ("conversationId", "businessId")
  REFERENCES "Conversation"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_conversationId_businessId_fkey"
  FOREIGN KEY ("conversationId", "businessId")
  REFERENCES "Conversation"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;
