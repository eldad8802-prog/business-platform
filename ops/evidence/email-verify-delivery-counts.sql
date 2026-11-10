-- ============================================================================
-- email-verify-delivery-counts.sql
--
-- Read-only Production COUNTS for the email-verification diagnosis (2026-11-10): did the owners who signed up
-- since verification went on get their EMAIL_VERIFY email, did it reach the provider, did the link expire, and
-- did they verify. Also the WELCOME rows, which (since #748) follow verification.
--
-- "Since verification went on" = since the first EMAIL_VERIFY row (fallback 2026-10-22 if there is none).
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

ROLLBACK;
