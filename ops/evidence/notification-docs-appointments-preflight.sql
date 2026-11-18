-- ============================================================================
-- notification-docs-appointments-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261213090000_notification_docs_stuck_appointment_lead
--
-- Proves, from the catalog and counts only, that the migration will apply exactly as it did in the lab:
--   * it is not recorded yet and the ledger is clean;
--   * what it builds on is there: the activation migration 20261212090000_notification_engine_activation recorded
--     and finished (itself after the follow-up and the foundation, which made "NotificationSettings");
--   * the evidence (migration) role owns "Document" and "NotificationSettings" (adding a column, a check and a
--     trigger needs it);
--   * every name it introduces is free: the two columns, the check, the trigger function, the trigger;
--   * the baseline the evidence compares with: "Document" has row level security enabled and forced with its two
--     policies (p7w4d_tenant, p7adm_read), "NotificationSettings" with its four tenant policies;
--   * INFO: documents in status processing right now (they keep a NULL stamp, so they are never flagged) and the
--     number of settings rows (all keep the default lead time) — counts, never a failure.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification docs + appointments preflight: legend (n -> check) =='
\echo ' 1 the migration is not recorded (observed = ledger rows with its name)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the activation migration 20261212090000 is recorded and finished (observed = such rows)'
\echo ' 4 the evidence role owns Document and NotificationSettings (observed = of 2)'
\echo ' 5 none of the new names is taken: two columns, the check, the function, the trigger (observed = taken)'
\echo ' 6 Document: row level security enabled and forced, policies p7w4d_tenant and p7adm_read (observed = policies)'
\echo ' 7 NotificationSettings: row level security enabled and forced, four tenant policies (observed = policies)'
\echo ' 8 INFO: documents in status processing now (they stay unstamped, never flagged)'
\echo ' 9 INFO: notification settings rows (all keep the default lead time)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
doc AS (SELECT * FROM rel WHERE nm = 'Document'),
ns AS (SELECT * FROM rel WHERE nm = 'NotificationSettings'),
taken(nm) AS (
            SELECT 'statusChangedAt' WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM doc)
                                                     AND a.attname = 'statusChangedAt' AND NOT a.attisdropped)
  UNION ALL SELECT 'appointmentReminderMinutes' WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM ns)
                                                     AND a.attname = 'appointmentReminderMinutes' AND NOT a.attisdropped)
  UNION ALL SELECT 'check' WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = 'NotificationSettings_appointment_reminder'
                                           AND k.connamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 'function' WHERE EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'document_status_changed_at'
                                              AND p.pronamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 'trigger' WHERE EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'Document_status_changed_at')
),
docpol AS (SELECT p.polname FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM doc)),
nspol AS (SELECT p.polname FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM ns)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE nm IN ('Document', 'NotificationSettings') AND relowner = (SELECT oid FROM me)) = 2,
                      (SELECT count(*) FROM rel WHERE nm IN ('Document', 'NotificationSettings') AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM taken), (SELECT count(*) FROM taken)
  UNION ALL SELECT 6, (SELECT count(*) FROM doc WHERE relrowsecurity AND relforcerowsecurity) = 1
                      AND (SELECT count(*) FROM docpol) = 2
                      AND (SELECT count(*) FROM docpol WHERE polname IN ('p7w4d_tenant', 'p7adm_read')) = 2,
                      (SELECT count(*) FROM docpol)
  UNION ALL SELECT 7, (SELECT count(*) FROM ns WHERE relrowsecurity AND relforcerowsecurity) = 1
                      AND (SELECT count(*) FROM nspol) = 4
                      AND (SELECT count(*) FROM nspol WHERE polname LIKE 'notification\_settings\_tenant\_%') = 4,
                      (SELECT count(*) FROM nspol)
  UNION ALL SELECT 8, true, (SELECT count(*) FROM "Document" WHERE "status" = 'processing')
  UNION ALL SELECT 9, true, (SELECT count(*) FROM "NotificationSettings")
)
SELECT n, CASE WHEN n IN (8, 9) THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
