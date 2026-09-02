-- Read-only Production evidence: can the Conversation subgraph accept the
-- tenant-coherent composite foreign keys?
--
-- WHY THIS EXISTS
--
-- `20260902090000_d2_ad2a3_conversation_tenant_coherence` swaps the single-column
-- foreign keys on "Message" and "ReplySuggestion" for composite ones spanning
-- (conversationId, businessId). PostgreSQL verifies a new foreign key against
-- every existing row at the moment it is added. If even one child row carries a
-- businessId that disagrees with its parent Conversation, the whole migration
-- fails and unwinds.
--
-- The migration file states the Production Conversation subgraph was measured
-- empty. That is prose in a file, not an observation of this database. This
-- query set is the observation.
--
-- It answers four questions and asks nothing else:
--   C1  how large the subgraph actually is
--   C2  "Message" rows whose businessId disagrees with their Conversation
--   C3  "ReplySuggestion" rows whose businessId disagrees with their Conversation
--   C4  child rows pointing at a Conversation that is not there at all
--
-- A zero in C2, C3 and C4 means the composite keys can be added without the
-- validation step failing. A non-zero means the migration WILL fail, and the
-- rows have to be reconciled first.
--
-- PRIVACY: every result is a count. No message body, phone number, name, address
-- or business record is ever selected. C1 reads row totals only.
--
-- SELECT-only, inside a READ ONLY transaction that always ends by unwinding, with
-- a session-level read-only guard and a statement timeout. A CI guard rejects
-- this file if it contains any write keyword, scanning prose as well as SQL, so
-- the wording here deliberately avoids those words.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== C1: size of the Conversation subgraph =='
SELECT (SELECT count(*) FROM "Conversation")    AS conversations,
       (SELECT count(*) FROM "Message")         AS messages,
       (SELECT count(*) FROM "ReplySuggestion") AS reply_suggestions;

\echo '== C2: Message rows whose tenant disagrees with their Conversation (expected 0) =='
SELECT count(*) AS incoherent_messages
FROM "Message" m
JOIN "Conversation" c ON c."id" = m."conversationId"
WHERE m."businessId" IS DISTINCT FROM c."businessId";

\echo '== C3: ReplySuggestion rows whose tenant disagrees (expected 0) =='
SELECT count(*) AS incoherent_reply_suggestions
FROM "ReplySuggestion" r
JOIN "Conversation" c ON c."id" = r."conversationId"
WHERE r."businessId" IS DISTINCT FROM c."businessId";

\echo '== C4: child rows whose Conversation is absent (expected 0) =='
SELECT (SELECT count(*) FROM "Message" m
          WHERE NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = m."conversationId"))
         AS orphan_messages,
       (SELECT count(*) FROM "ReplySuggestion" r
          WHERE NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = r."conversationId"))
         AS orphan_reply_suggestions;

\echo '== C5: is the composite parent key already present (idempotence check) =='
SELECT count(*) AS conversation_id_business_unique_indexes
FROM pg_indexes
WHERE tablename = 'Conversation'
  AND indexname = 'Conversation_id_businessId_key';

ROLLBACK;
