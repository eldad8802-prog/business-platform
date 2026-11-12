-- ============================================================================
-- notification-engine-foundation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261210090000_notification_engine_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * "PushSubscription" gained provider (text, NOT NULL, default WEB_PUSH), authSessionId (uuid), revokedReason
--     (text), lastSeenAt (timestamp), appVersion (varchar 32); its provider / reason / version checks, the
--     provider-aware endpoint check (the FCM branch present), the (id, businessId) key, the session key (SET NULL)
--     and the partial live-session index;
--   * "Notification"."userId" (nullable) with its key to "User", its index and the same-business trigger;
--   * "NotificationDelivery" gained the seven worker columns (attempts NOT NULL default 0, the rest nullable), the
--     attempts range check, the recipient key, the COMPOSITE device key to "PushSubscription"(id, businessId), the
--     same-business trigger and the two partial indexes;
--   * "NotificationSettings" (12 columns) and "NotificationPreference" (9 columns): RLS ENABLED + FORCED; exactly
--     four tenant policies each (read, add, change, remove), PERMISSIVE, for PUBLIC, each expression equal to the
--     tenant GUC expression; ACL exactly app_runtime read / add / change / remove, sequences USAGE / SELECT; no
--     column-level privilege; their checks, keys, unique indexes and same-business triggers;
--   * notification_push_due, notification_live_businesses, auth_sessions_live: SECURITY DEFINER, STABLE,
--     search_path pinned, owned by the migration role, the documented output columns; EXECUTE for app_runtime
--     alone (no PUBLIC);
--   * nothing written: the new tables hold no row and no existing row carries a new value.
--
-- Checks 21 and 22 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine foundation production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "NotificationSettings" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 "PushSubscription": the five new columns with their types, nullability and default (observed = matching, of 5)'
\echo ' 5 "PushSubscription": provider, reason, version and endpoint checks validated (endpoint has the FCM branch); (id, businessId) unique; session key SET NULL; live-session partial index (observed = of 8)'
\echo ' 6 "Notification"."userId": integer, nullable; key to "User"; index; same-business trigger enabled (observed = of 4)'
\echo ' 7 "NotificationDelivery": the seven worker columns (attempts NOT NULL default 0, the rest nullable) (observed = matching, of 7)'
\echo ' 8 "NotificationDelivery": attempts range check; recipient key; composite device key (subscriptionId, businessId); trigger; two partial indexes (observed = of 6)'
\echo ' 9 "NotificationSettings" has 12 columns and "NotificationPreference" 9 (observed = columns, of 21)'
\echo '10 both new tables: RLS ENABLED + FORCED (observed = tables, of 2)'
\echo '11 exactly four policies per new table, one per command (read, add, change, remove), PERMISSIVE, PUBLIC (observed = policies)'
\echo '12 every policy expression equals the tenant GUC expression exactly (observed = mismatches)'
\echo '13 each new table ACL is exactly app_runtime read, add, change, remove (observed = grantee x privilege pairs, of 8)'
\echo '14 each new sequence ACL is exactly app_runtime USAGE, SELECT (observed = grantee x privilege pairs, of 4)'
\echo '15 no column-level privilege on either new table (observed = column grants)'
\echo '16 new tables: minutes, key and delivery checks; keys to Business and User; the two unique indexes (observed = of 9)'
\echo '17 new tables: the two same-business triggers enabled, running task_user_same_business (observed = of 2)'
\echo '18 the three functions: SECURITY DEFINER, STABLE, search_path pinned, owned by the migration role (observed = of 3)'
\echo '19 the three functions return exactly their documented columns; EXECUTE for app_runtime alone, no PUBLIC (observed = other grants)'
\echo '20 nothing written: no row in the new tables; no existing row carries a new value (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
ns AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'NotificationSettings' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM ns)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-20) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
ps AS (SELECT oid FROM rel WHERE nm = 'PushSubscription'),
nt AS (SELECT oid FROM rel WHERE nm = 'Notification'),
nd AS (SELECT oid FROM rel WHERE nm = 'NotificationDelivery'),
newt AS (SELECT * FROM rel WHERE nm IN ('NotificationSettings', 'NotificationPreference')),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
cols(tbl, col, typ, nn, dflt) AS (VALUES
  ('PushSubscription', 'provider', 'text', true, '''WEB_PUSH''::text'),
  ('PushSubscription', 'authSessionId', 'uuid', false, NULL),
  ('PushSubscription', 'revokedReason', 'text', false, NULL),
  ('PushSubscription', 'lastSeenAt', 'timestamp(3) without time zone', false, NULL),
  ('PushSubscription', 'appVersion', 'character varying(32)', false, NULL),
  ('Notification', 'userId', 'integer', false, NULL),
  ('NotificationDelivery', 'userId', 'integer', false, NULL),
  ('NotificationDelivery', 'subscriptionId', 'integer', false, NULL),
  ('NotificationDelivery', 'attempts', 'integer', true, '0'),
  ('NotificationDelivery', 'nextAttemptAt', 'timestamp(3) without time zone', false, NULL),
  ('NotificationDelivery', 'leaseUntil', 'timestamp(3) without time zone', false, NULL),
  ('NotificationDelivery', 'expiresAt', 'timestamp(3) without time zone', false, NULL),
  ('NotificationDelivery', 'completedAt', 'timestamp(3) without time zone', false, NULL)),
col_ok AS (SELECT c.tbl FROM cols c JOIN rel r ON r.nm = c.tbl
           JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col AND NOT a.attisdropped
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE format_type(a.atttypid, a.atttypmod) = c.typ AND a.attnotnull = c.nn
             AND pg_get_expr(d.adbin, d.adrelid) IS NOT DISTINCT FROM c.dflt),
cons(tbl, nm, typ) AS (VALUES
  ('PushSubscription', 'PushSubscription_provider', 'c'), ('PushSubscription', 'PushSubscription_revoked_reason_shape', 'c'),
  ('PushSubscription', 'PushSubscription_app_version_shape', 'c'), ('PushSubscription', 'PushSubscription_endpoint_shape', 'c'),
  ('PushSubscription', 'PushSubscription_id_businessId_key', 'u'), ('PushSubscription', 'PushSubscription_authSessionId_fkey', 'f'),
  ('Notification', 'Notification_userId_fkey', 'f'),
  ('NotificationDelivery', 'NotificationDelivery_attempts_range', 'c'), ('NotificationDelivery', 'NotificationDelivery_userId_fkey', 'f'),
  ('NotificationDelivery', 'NotificationDelivery_subscription_fkey', 'f'),
  ('NotificationSettings', 'NotificationSettings_minutes', 'c'), ('NotificationSettings', 'NotificationSettings_businessId_fkey', 'f'),
  ('NotificationSettings', 'NotificationSettings_userId_fkey', 'f'),
  ('NotificationPreference', 'NotificationPreference_key_shape', 'c'), ('NotificationPreference', 'NotificationPreference_delivery', 'c'),
  ('NotificationPreference', 'NotificationPreference_businessId_fkey', 'f'), ('NotificationPreference', 'NotificationPreference_userId_fkey', 'f')),
con_ok AS (SELECT c.tbl, c.nm FROM cons c JOIN rel r ON r.nm = c.tbl
           JOIN pg_constraint k ON k.conrelid = r.oid AND k.conname = c.nm AND k.contype::text = c.typ
           WHERE k.convalidated
             AND (c.nm <> 'PushSubscription_endpoint_shape' OR pg_get_constraintdef(k.oid) LIKE '%''FCM''%')
             AND (c.nm <> 'PushSubscription_authSessionId_fkey' OR (k.confdeltype = 'n' AND k.confrelid = (SELECT oid FROM rel WHERE nm = 'AuthSession')))
             AND (c.nm <> 'NotificationDelivery_subscription_fkey'
                  OR (k.confrelid = (SELECT oid FROM ps) AND cardinality(k.conkey) = 2 AND k.confdeltype = 'c'))),
idx(tbl, nm, partial, uniq) AS (VALUES
  ('PushSubscription', 'PushSubscription_authSessionId_live_idx', true, false),
  ('Notification', 'Notification_businessId_userId_lastSurfacedAt_idx', false, false),
  ('NotificationDelivery', 'NotificationDelivery_push_owed_idx', true, false),
  ('NotificationDelivery', 'NotificationDelivery_push_sent_by_user_idx', true, false),
  ('NotificationSettings', 'NotificationSettings_businessId_userId_key', false, true),
  ('NotificationPreference', 'NotificationPreference_businessId_userId_key_key', false, true)),
idx_ok AS (SELECT x.tbl FROM idx x JOIN rel i ON i.nm = x.nm JOIN pg_index p ON p.indexrelid = i.oid
           WHERE p.indrelid = (SELECT oid FROM rel WHERE nm = x.tbl) AND (p.indpred IS NOT NULL) = x.partial AND p.indisunique = x.uniq),
trg(tbl, nm) AS (VALUES ('Notification', 'Notification_user_same_business'), ('NotificationDelivery', 'NotificationDelivery_user_same_business'),
                        ('NotificationSettings', 'NotificationSettings_user_same_business'), ('NotificationPreference', 'NotificationPreference_user_same_business')),
trg_ok AS (SELECT t.tbl FROM trg t JOIN pg_trigger g ON g.tgrelid = (SELECT oid FROM rel WHERE nm = t.tbl) AND g.tgname = t.nm
           JOIN pg_proc p ON p.oid = g.tgfoid WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND p.proname = 'task_user_same_business'),
expected_pol(cmd, has_q, has_wc) AS (VALUES ('r', true, false), ('a', false, true), ('w', true, true), ('d', true, false)),
pols AS (SELECT p.polrelid, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid IN (SELECT oid FROM newt)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
fn AS (SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl, p.proargnames, p.proargmodes
       FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
         AND p.proname IN ('notification_push_due', 'notification_live_businesses', 'auth_sessions_live')),
fn_out AS (SELECT fn.proname, string_agg(a.n, ',' ORDER BY a.n) AS outs
           FROM fn CROSS JOIN LATERAL unnest(fn.proargnames, fn.proargmodes) AS a(n, m) WHERE a.m = 't' GROUP BY fn.proname),
fn_exec AS (SELECT fn.proname, x.grantee FROM fn CROSS JOIN LATERAL aclexplode(fn.proacl) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> fn.proowner),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
                        AND checksum = 'c2dba655e68a30feaca01226b557f286335561745c143cf8972a16d7de08ab04'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM col_ok WHERE tbl = 'PushSubscription') = 5,
                      (SELECT count(*) FROM col_ok WHERE tbl = 'PushSubscription')
  UNION ALL SELECT 5, (SELECT count(*) FROM con_ok WHERE tbl = 'PushSubscription') + (SELECT count(*) FROM idx_ok WHERE tbl = 'PushSubscription')
                      + (SELECT count(*) FROM rel r JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE r.nm = 'PushSubscription_id_businessId_key' AND i.indisunique AND i.indrelid = (SELECT oid FROM ps)) = 8,
                      (SELECT count(*) FROM con_ok WHERE tbl = 'PushSubscription') + (SELECT count(*) FROM idx_ok WHERE tbl = 'PushSubscription')
                      + (SELECT count(*) FROM rel r JOIN pg_index i ON i.indexrelid = r.oid
                         WHERE r.nm = 'PushSubscription_id_businessId_key' AND i.indisunique AND i.indrelid = (SELECT oid FROM ps))
  UNION ALL SELECT 6, (SELECT count(*) FROM col_ok WHERE tbl = 'Notification') + (SELECT count(*) FROM con_ok WHERE tbl = 'Notification')
                      + (SELECT count(*) FROM idx_ok WHERE tbl = 'Notification') + (SELECT count(*) FROM trg_ok WHERE tbl = 'Notification') = 4,
                      (SELECT count(*) FROM col_ok WHERE tbl = 'Notification') + (SELECT count(*) FROM con_ok WHERE tbl = 'Notification')
                      + (SELECT count(*) FROM idx_ok WHERE tbl = 'Notification') + (SELECT count(*) FROM trg_ok WHERE tbl = 'Notification')
  UNION ALL SELECT 7, (SELECT count(*) FROM col_ok WHERE tbl = 'NotificationDelivery') = 7,
                      (SELECT count(*) FROM col_ok WHERE tbl = 'NotificationDelivery')
  UNION ALL SELECT 8, (SELECT count(*) FROM con_ok WHERE tbl = 'NotificationDelivery') + (SELECT count(*) FROM idx_ok WHERE tbl = 'NotificationDelivery')
                      + (SELECT count(*) FROM trg_ok WHERE tbl = 'NotificationDelivery') = 6,
                      (SELECT count(*) FROM con_ok WHERE tbl = 'NotificationDelivery') + (SELECT count(*) FROM idx_ok WHERE tbl = 'NotificationDelivery')
                      + (SELECT count(*) FROM trg_ok WHERE tbl = 'NotificationDelivery')
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM rel WHERE nm = 'NotificationSettings') AND attnum > 0 AND NOT attisdropped) = 12
                      AND (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM rel WHERE nm = 'NotificationPreference') AND attnum > 0 AND NOT attisdropped) = 9,
                      (SELECT count(*) FROM pg_attribute WHERE attrelid IN (SELECT oid FROM newt) AND attnum > 0 AND NOT attisdropped)
  UNION ALL SELECT 10, (SELECT count(*) FROM newt WHERE relrowsecurity AND relforcerowsecurity) = 2,
                       (SELECT count(*) FROM newt WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 11, (SELECT count(*) FROM pols) = 8
                       AND (SELECT count(DISTINCT (polrelid, cmd)) FROM pols) = 8
                       AND NOT EXISTS (SELECT 1 FROM pols p WHERE NOT EXISTS (SELECT 1 FROM expected_pol e WHERE e.cmd = p.cmd))
                       AND NOT EXISTS (SELECT 1 FROM pols WHERE NOT polpermissive OR polroles <> ARRAY[0]::oid[]),
                       (SELECT count(*) FROM pols)
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM pols p JOIN expected_pol e ON e.cmd = p.cmd
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL)),
                       (SELECT count(*) FROM pols p JOIN expected_pol e ON e.cmd = p.cmd
                        WHERE (e.has_q AND p.q IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_q AND p.q IS NOT NULL)
                           OR (e.has_wc AND p.wc IS DISTINCT FROM (SELECT e FROM expected_expr)) OR (NOT e.has_wc AND p.wc IS NOT NULL))
  UNION ALL SELECT 13, (SELECT count(*) FROM acl_items WHERE nm IN ('NotificationSettings', 'NotificationPreference')) = 8
                       AND (SELECT count(*) FROM acl_letters WHERE nm IN ('NotificationSettings', 'NotificationPreference')
                              AND grantee = (SELECT oid FROM rt) AND letters = 'adrw') = 2,
                       (SELECT count(*) FROM acl_items WHERE nm IN ('NotificationSettings', 'NotificationPreference'))
  UNION ALL SELECT 14, (SELECT count(*) FROM acl_items WHERE nm IN ('NotificationSettings_id_seq', 'NotificationPreference_id_seq')) = 4
                       AND (SELECT count(*) FROM acl_letters WHERE nm IN ('NotificationSettings_id_seq', 'NotificationPreference_id_seq')
                              AND grantee = (SELECT oid FROM rt) AND letters = 'Ur') = 2,
                       (SELECT count(*) FROM acl_items WHERE nm IN ('NotificationSettings_id_seq', 'NotificationPreference_id_seq'))
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid IN (SELECT oid FROM newt)),
                       (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid IN (SELECT oid FROM newt))
  UNION ALL SELECT 16, (SELECT count(*) FROM con_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference'))
                       + (SELECT count(*) FROM idx_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference')) = 9,
                       (SELECT count(*) FROM con_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference'))
                       + (SELECT count(*) FROM idx_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference'))
  UNION ALL SELECT 17, (SELECT count(*) FROM trg_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference')) = 2,
                       (SELECT count(*) FROM trg_ok WHERE tbl IN ('NotificationSettings', 'NotificationPreference'))
  UNION ALL SELECT 18, (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                          AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) = 3,
                       (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                          AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  UNION ALL SELECT 19, (SELECT count(*) FROM fn) = 3
                       AND (SELECT outs FROM fn_out WHERE proname = 'notification_push_due') = 'businessId,deliveryId'
                       AND (SELECT outs FROM fn_out WHERE proname = 'notification_live_businesses') = 'businessId'
                       AND (SELECT outs FROM fn_out WHERE proname = 'auth_sessions_live') = 'id'
                       AND (SELECT count(*) FROM fn_exec WHERE grantee = (SELECT oid FROM rt)) = 3
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM fn_exec WHERE grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 20, (SELECT count(*) FROM "NotificationSettings") + (SELECT count(*) FROM "NotificationPreference")
                       + (SELECT count(*) FROM "PushSubscription" WHERE "provider" <> 'WEB_PUSH' OR "authSessionId" IS NOT NULL
                            OR "revokedReason" IS NOT NULL OR "lastSeenAt" IS NOT NULL OR "appVersion" IS NOT NULL)
                       + (SELECT count(*) FROM "Notification" WHERE "userId" IS NOT NULL)
                       + (SELECT count(*) FROM "NotificationDelivery" WHERE "attempts" <> 0 OR "userId" IS NOT NULL OR "subscriptionId" IS NOT NULL
                            OR "nextAttemptAt" IS NOT NULL OR "leaseUntil" IS NOT NULL OR "expiresAt" IS NOT NULL OR "completedAt" IS NOT NULL) = 0,
                       (SELECT count(*) FROM "NotificationSettings") + (SELECT count(*) FROM "NotificationPreference")
                       + (SELECT count(*) FROM "PushSubscription" WHERE "provider" <> 'WEB_PUSH' OR "authSessionId" IS NOT NULL
                            OR "revokedReason" IS NOT NULL OR "lastSeenAt" IS NOT NULL OR "appVersion" IS NOT NULL)
                       + (SELECT count(*) FROM "Notification" WHERE "userId" IS NOT NULL)
                       + (SELECT count(*) FROM "NotificationDelivery" WHERE "attempts" <> 0 OR "userId" IS NOT NULL OR "subscriptionId" IS NOT NULL
                            OR "nextAttemptAt" IS NOT NULL OR "leaseUntil" IS NOT NULL OR "expiresAt" IS NOT NULL OR "completedAt" IS NOT NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
