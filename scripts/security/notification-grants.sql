-- Notification persistence — least-privilege runtime grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role for the environment (Preview today:
-- app_runtime_preview_*). Production still runs as the owner, so these grants are
-- not yet load-bearing there — but they will be at the runtime cutover, and a
-- consumer written without them would work in Production and fail on Preview.
--
-- INERT. This file is applied manually, per the convention every P7 wave uses:
-- migrations carry no environment-specific role names, passwords or endpoints.
--
-- ORDERING — this matters and the release guard does NOT protect it:
--
--   1. migration merged and applied     -> tables exist
--   2. THIS FILE applied                -> app_runtime can use them
--   3. grants verified (query below)    -> read-only proof
--   4. consumer code merged             -> first reader/writer ships
--
-- Applying the consumer before step 2 produces "permission denied for relation
-- Notification" on a restricted runtime. The release guard would not catch it:
-- its question is "is the migration applied?", and the answer would be yes. The
-- migration and the privileges to use it are two different facts.
--
-- VERBS — code-observed, not speculative. The notification writer (a later
-- increment) inserts a notification, updates it when the same fact resurfaces or
-- the owner reads/dismisses it, and appends delivery attempts.
--
-- ZERO DELETE anywhere. A notification is never deleted by the application:
-- resolving sets `resolvedAt`, and the only delete that can reach these tables
-- is the Business cascade during account deletion, which runs with the
-- privileges of that flow rather than the tenant runtime.

-- Notification: the writer creates rows, reopens them, and marks them read.
GRANT SELECT, INSERT, UPDATE ON "Notification" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "Notification_id_seq" TO :ROLE;

-- NotificationDelivery: append-only attempt history. INSERT plus UPDATE, because
-- an attempt starts PENDING and is later resolved to SENT or FAILED.
GRANT SELECT, INSERT, UPDATE ON "NotificationDelivery" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "NotificationDelivery_id_seq" TO :ROLE;

-- ── Verification (read-only; run as any role that can read the catalogue) ────
--
-- Expected: exactly the verbs above, and NO 'DELETE' row for either table.
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = '<role>'
--     AND table_name IN ('Notification', 'NotificationDelivery')
--   ORDER BY table_name, privilege_type;
--
-- A 'DELETE' appearing there is a defect, not a convenience.
