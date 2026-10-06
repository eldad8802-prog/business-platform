-- ============================================================================
-- whatsapp-es-v4-switch-evidence.sql
--
-- Read-only Production snapshot for the WhatsApp Embedded Signup v4 switch.
-- Run it twice: BEFORE the switch (new configuration id + v4 launch code) and
-- AFTER it. The switch only changes how a NEW connection is launched; every
-- existing connection must come out of it untouched. Compare the two outputs:
--   S1/S2  identical rows (same connections, same status, same last-change time)
--   S3     WhatsApp intake receipts keep arriving after the switch (when there is traffic)
--   X1     the evidence role bypasses row-level security, so the counts are whole
--
-- PRIVACY: no phone number, no WABA id, no name is printed. Each connection is
-- shown by its row id, its business id and a 12-character fingerprint of its
-- WABA + phone-number ids (stable across runs, not reversible to the ids).
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== WhatsApp ES v4 switch snapshot — legend =='
\echo ' S1 connections per status'
\echo ' S2 one row per connection: id | businessId | status | fingerprint | updatedAt | lastVerifiedAt | lastErrorCode'
\echo ' S3 WhatsApp intake receipts: total | last 24h | latest receivedAt'
\echo ' X1 evidence role bypasses row-level security (true = whole counts)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

\echo '-- S1'
SELECT status::text AS status, count(*) AS connections
FROM "WhatsAppConnection"
GROUP BY status
ORDER BY status;

\echo '-- S2'
SELECT id,
       "businessId",
       status::text AS status,
       left(md5("wabaId" || ':' || "phoneNumberId"), 12) AS fingerprint,
       "updatedAt",
       "lastVerifiedAt",
       "lastErrorCode"
FROM "WhatsAppConnection"
ORDER BY id;

\echo '-- S3'
SELECT count(*) AS receipts_total,
       count(*) FILTER (WHERE "receivedAt" > now() - interval '24 hours') AS receipts_last_24h,
       max("receivedAt") AS latest_received_at
FROM "IntakeEvent"
WHERE "sourceKey" = 'whatsapp';

\echo '-- X1'
SELECT (rolbypassrls OR rolsuper) AS evidence_role_sees_all_rows
FROM pg_roles
WHERE rolname = current_user;

ROLLBACK;
