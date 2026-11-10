-- ============================================================================
-- email-verify-delivery-counts.sql
--
-- Read-only Production COUNTS for the email-verification diagnosis (2026-11-10): did the owners who signed up
-- since verification went on get their EMAIL_VERIFY email, did it reach the provider, did the link expire, and
-- did they verify. Also the WELCOME rows, which (since #748) follow verification.
--
-- "Since verification went on" = since the first EMAIL_VERIFY row (fallback 2026-10-22 if there is none).
--
-- Section 5 splits those signups at the moment #1074 (WELCOME at signup) began serving Production:
-- 2026-11-10 10:49:17 UTC — the Vercel "success" deployment status for revision 4028145e (GitHub deployment
-- 7680032140, dpl_DYsyU15FNfZKDPDEZKfSJ7q99xjM). Until then the previous deployment served signups (#1074
-- landed on main at 10:46:58, the build started 10:47:01). A signup is "Google" when its Google identity was linked within
-- 60 seconds of the account's creation (Google signup links it in the account transaction); every other
-- account is a password signup — a password account that links Google later stays "password".
--
-- PRIVACY: counts only. No address, name, id, digest, payload, business name or error text is selected.
-- Every column is named *_count so scripts/ci/evidence-redact.mjs passes the integers through.
-- Guard-clean: SELECT only, inside a READ ONLY transaction rolled back at the end.
-- ============================================================================

\echo '== 1. EMAIL_VERIFY outbox rows by status / delivery =='
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH v AS (SELECT * FROM "TransactionalEmail" WHERE "kind" = 'EMAIL_VERIFY'),
nowu AS (SELECT timezone('UTC', now()) AS t)
SELECT
  (SELECT count(*) FROM v)                                                                     AS verify_rows_count,
  (SELECT count(*) FROM v WHERE "status" = 'PENDING')                                          AS verify_pending_count,
  (SELECT count(*) FROM v WHERE "status" = 'SENDING')                                          AS verify_sending_count,
  (SELECT count(*) FROM v WHERE "status" = 'SENT')                                             AS verify_sent_count,
  (SELECT count(*) FROM v WHERE "status" = 'FAILED')                                           AS verify_failed_count,
  (SELECT count(*) FROM v WHERE "status" = 'EXPIRED')                                          AS verify_expired_count,
  (SELECT count(*) FROM v WHERE "providerMessageId" IS NOT NULL)                               AS verify_with_provider_id_count,
  (SELECT count(*) FROM v WHERE "attempts" > 1)                                                AS verify_retried_count,
  (SELECT count(*) FROM v WHERE "lastErrorCode" IS NOT NULL)                                   AS verify_with_error_code_count,
  (SELECT count(*) FROM v, nowu WHERE "status" = 'PENDING' AND "nextAttemptAt" < nowu.t - interval '15 minutes') AS verify_pending_overdue_count,
  (SELECT count(*) FROM v, nowu WHERE "status" = 'PENDING' AND "expiresAt" < nowu.t)          AS verify_pending_past_expiry_count,
  (SELECT count(*) FROM v, nowu WHERE "createdAt" >= nowu.t - interval '7 days')               AS verify_last_7_days_count;

\echo '== 2. owners who signed up since verification went on =='

WITH anchor AS (
  SELECT coalesce((SELECT min("createdAt") FROM "TransactionalEmail" WHERE "kind" = 'EMAIL_VERIFY'),
                  timestamp '2026-10-22 00:00:00') AS t
),
s AS (
  SELECT u."id", u."emailVerifiedAt" IS NOT NULL AS verified, u."password" IS NOT NULL AS has_password,
         u."lastLoginAt" IS NOT NULL AS signed_in,
         EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id")                                   AS google,
         EXISTS (SELECT 1 FROM "TransactionalEmail" t WHERE t."userId" = u."id" AND t."kind" = 'EMAIL_VERIFY') AS has_verify,
         EXISTS (SELECT 1 FROM "TransactionalEmail" t WHERE t."userId" = u."id" AND t."kind" = 'EMAIL_VERIFY'
                   AND t."status" = 'SENT')                                                                    AS verify_sent,
         EXISTS (SELECT 1 FROM "TransactionalEmail" t WHERE t."userId" = u."id" AND t."kind" = 'WELCOME')      AS has_welcome
  FROM "User" u, anchor
  WHERE u."createdAt" >= anchor.t
)
SELECT
  (SELECT count(*) FROM s)                                                     AS signups_count,
  (SELECT count(*) FROM s WHERE has_password)                                  AS signups_password_count,
  (SELECT count(*) FROM s WHERE google)                                        AS signups_google_count,
  (SELECT count(*) FROM s WHERE has_verify)                                    AS signups_with_verify_email_count,
  (SELECT count(*) FROM s WHERE has_password AND NOT google AND NOT has_verify) AS signups_password_no_verify_email_count,
  (SELECT count(*) FROM s WHERE verified)                                      AS signups_verified_count,
  (SELECT count(*) FROM s WHERE NOT verified)                                  AS signups_unverified_count,
  (SELECT count(*) FROM s WHERE NOT verified AND verify_sent)                  AS unverified_verify_sent_count,
  (SELECT count(*) FROM s WHERE NOT verified AND has_verify AND NOT verify_sent) AS unverified_verify_never_sent_count,
  (SELECT count(*) FROM s WHERE NOT verified AND signed_in)                    AS unverified_signed_in_count,
  (SELECT count(*) FROM s WHERE has_welcome)                                   AS signups_with_welcome_count,
  (SELECT count(*) FROM s WHERE NOT has_welcome)                               AS signups_without_welcome_count;

\echo '== 3. EMAIL_VERIFY links (AuthEmailToken) =='

WITH k AS (SELECT * FROM "AuthEmailToken" WHERE "purpose" = 'EMAIL_VERIFY'),
nowu AS (SELECT timezone('UTC', now()) AS t)
SELECT
  (SELECT count(*) FROM k)                                                                         AS verify_links_count,
  (SELECT count(*) FROM k WHERE "consumedAt" IS NOT NULL)                                          AS verify_links_used_count,
  (SELECT count(*) FROM k WHERE "invalidatedAt" IS NOT NULL AND "consumedAt" IS NULL)              AS verify_links_superseded_count,
  (SELECT count(*) FROM k, nowu WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" < nowu.t)  AS verify_links_expired_unused_count,
  (SELECT count(*) FROM k, nowu WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" >= nowu.t) AS verify_links_live_count;

\echo '== 4. WELCOME outbox rows by status =='

WITH w AS (SELECT * FROM "TransactionalEmail" WHERE "kind" = 'WELCOME')
SELECT
  (SELECT count(*) FROM w)                                     AS welcome_rows_count,
  (SELECT count(*) FROM w WHERE "status" = 'PENDING')          AS welcome_pending_count,
  (SELECT count(*) FROM w WHERE "status" = 'SENDING')          AS welcome_sending_count,
  (SELECT count(*) FROM w WHERE "status" = 'SENT')             AS welcome_sent_count,
  (SELECT count(*) FROM w WHERE "status" = 'FAILED')           AS welcome_failed_count,
  (SELECT count(*) FROM w WHERE "status" = 'EXPIRED')          AS welcome_expired_count,
  (SELECT count(*) FROM w WHERE "lastErrorCode" IS NOT NULL)   AS welcome_with_error_code_count;

\echo '== 5a. signups before / after #1074 (cutoff 2026-11-10 10:49:17 UTC), with / without WELCOME, by method =='

WITH anchor AS (
  SELECT coalesce((SELECT min("createdAt") FROM "TransactionalEmail" WHERE "kind" = 'EMAIL_VERIFY'),
                  timestamp '2026-10-22 00:00:00') AS t
),
s AS (
  SELECT u."createdAt" >= timestamp '2026-11-10 10:49:17' AS post_fix,
         EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id"
                   AND abs(extract(epoch FROM (i."linkedAt" - u."createdAt"))) <= 60)                      AS google_signup,
         EXISTS (SELECT 1 FROM "TransactionalEmail" t WHERE t."userId" = u."id" AND t."kind" = 'WELCOME')      AS has_welcome,
         EXISTS (SELECT 1 FROM "TransactionalEmail" t WHERE t."userId" = u."id" AND t."kind" = 'EMAIL_VERIFY') AS has_verify
  FROM "User" u, anchor
  WHERE u."createdAt" >= anchor.t
)
SELECT
  (SELECT count(*) FROM s WHERE NOT post_fix)                                             AS pre_fix_signups_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND has_welcome)                             AS pre_fix_with_welcome_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND NOT has_welcome)                         AS pre_fix_without_welcome_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND NOT google_signup)                       AS pre_fix_password_signups_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND NOT google_signup AND has_welcome)       AS pre_fix_password_with_welcome_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND NOT google_signup AND NOT has_welcome)   AS pre_fix_password_without_welcome_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND google_signup)                           AS pre_fix_google_signups_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND google_signup AND has_welcome)           AS pre_fix_google_with_welcome_count,
  (SELECT count(*) FROM s WHERE NOT post_fix AND google_signup AND NOT has_welcome)       AS pre_fix_google_without_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix)                                                 AS post_fix_signups_count,
  (SELECT count(*) FROM s WHERE post_fix AND has_welcome)                                 AS post_fix_with_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix AND NOT has_welcome)                             AS post_fix_without_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix AND NOT google_signup)                           AS post_fix_password_signups_count,
  (SELECT count(*) FROM s WHERE post_fix AND NOT google_signup AND has_welcome)           AS post_fix_password_with_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix AND NOT google_signup AND NOT has_welcome)       AS post_fix_password_without_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix AND NOT google_signup AND has_verify)            AS post_fix_password_with_verify_email_count,
  (SELECT count(*) FROM s WHERE post_fix AND google_signup)                               AS post_fix_google_signups_count,
  (SELECT count(*) FROM s WHERE post_fix AND google_signup AND has_welcome)               AS post_fix_google_with_welcome_count,
  (SELECT count(*) FROM s WHERE post_fix AND google_signup AND NOT has_welcome)           AS post_fix_google_without_welcome_count;

\echo '== 5b. WELCOME status of the signups after #1074, by method =='

WITH p AS (
  SELECT t."status",
         EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id"
                   AND abs(extract(epoch FROM (i."linkedAt" - u."createdAt"))) <= 60) AS google_signup
  FROM "TransactionalEmail" t JOIN "User" u ON u."id" = t."userId"
  WHERE t."kind" = 'WELCOME' AND u."createdAt" >= timestamp '2026-11-10 10:49:17'
)
SELECT
  (SELECT count(*) FROM p WHERE "status" = 'PENDING')                         AS post_fix_welcome_pending_count,
  (SELECT count(*) FROM p WHERE "status" = 'SENDING')                         AS post_fix_welcome_sending_count,
  (SELECT count(*) FROM p WHERE "status" = 'SENT')                            AS post_fix_welcome_sent_count,
  (SELECT count(*) FROM p WHERE "status" = 'FAILED')                          AS post_fix_welcome_failed_count,
  (SELECT count(*) FROM p WHERE "status" = 'EXPIRED')                         AS post_fix_welcome_expired_count,
  (SELECT count(*) FROM p WHERE NOT google_signup AND "status" = 'PENDING')   AS post_fix_password_welcome_pending_count,
  (SELECT count(*) FROM p WHERE NOT google_signup AND "status" = 'SENDING')   AS post_fix_password_welcome_sending_count,
  (SELECT count(*) FROM p WHERE NOT google_signup AND "status" = 'SENT')      AS post_fix_password_welcome_sent_count,
  (SELECT count(*) FROM p WHERE NOT google_signup AND "status" = 'FAILED')    AS post_fix_password_welcome_failed_count,
  (SELECT count(*) FROM p WHERE NOT google_signup AND "status" = 'EXPIRED')   AS post_fix_password_welcome_expired_count,
  (SELECT count(*) FROM p WHERE google_signup AND "status" = 'PENDING')       AS post_fix_google_welcome_pending_count,
  (SELECT count(*) FROM p WHERE google_signup AND "status" = 'SENDING')       AS post_fix_google_welcome_sending_count,
  (SELECT count(*) FROM p WHERE google_signup AND "status" = 'SENT')          AS post_fix_google_welcome_sent_count,
  (SELECT count(*) FROM p WHERE google_signup AND "status" = 'FAILED')        AS post_fix_google_welcome_failed_count,
  (SELECT count(*) FROM p WHERE google_signup AND "status" = 'EXPIRED')       AS post_fix_google_welcome_expired_count;

ROLLBACK;
