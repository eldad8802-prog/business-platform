-- D2 / P7-W4A — tenant-scoped replay idempotency for provider messages.
--
-- EXPAND-ONLY, idempotent. Promotes the advisory application-level wamid
-- dedup to a DB constraint: a (businessId, providerMessageId) pair can be
-- ingested once. NULL providerMessageId rows (app-created messages) are
-- unconstrained under Postgres NULL-distinct semantics, and identical
-- provider ids in two different businesses never cross-dedup.
CREATE UNIQUE INDEX IF NOT EXISTS "Message_businessId_providerMessageId_key"
  ON "Message"("businessId", "providerMessageId");
