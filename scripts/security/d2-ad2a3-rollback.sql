-- D2 / ACCOUNT-DELETION-2A.3 — rollback for the structural tenant-coherence migration.
--
-- Restores the exact pre-migration relational state: single-column Conversation FKs
-- on Message and ReplySuggestion, and drops the composite parent key plus the
-- cascade-support index.
--
-- This wave ships NO grants, NO roles and NO RLS policies, so there is nothing else
-- to undo — the paired *-grants.sql that other D2 waves carry does not exist here by
-- design (privilege delta is zero).
--
-- Rolling back REMOVES a security invariant. It is safe with respect to DATA (no row
-- is read, written or deleted) but it reopens the cross-tenant cascade exposure.

ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversationId_businessId_fkey";
ALTER TABLE "ReplySuggestion" DROP CONSTRAINT IF EXISTS "ReplySuggestion_conversationId_businessId_fkey";

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "ReplySuggestion_conversationId_businessId_idx";
DROP INDEX IF EXISTS "Conversation_id_businessId_key";
