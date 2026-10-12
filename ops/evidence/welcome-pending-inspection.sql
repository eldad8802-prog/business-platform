-- ============================================================================
-- welcome-pending-inspection.sql
--
-- Read-only Production INSPECTION of the transactional email outbox before sending is switched on.
-- Answers, per row, WITHOUT any personal data:
--   * which kind, which status, how many attempts, when it was recorded and until when it may be sent;
--   * whether it is still within its lifetime right now (i.e. whether a sweep would send it once
--     TRANSACTIONAL_EMAIL_ENABLED is on) or would be settled EXPIRED instead;
--   * what recorded it: the user it names — when that user and its business came into existence relative
--     to the row (a signup records the user, the business and the email in ONE transaction, so their
--     timestamps coincide), whether the user accepted the terms at signup, how many times it has signed
--     in since, and whether the business is in deletion.
-- Identifiers are reduced to an 8-character digest; no address, name, payload or business name is read.
--
-- OUTPUT: one line per outbox row (at most 50), then a summary line.
-- PRIVACY: digests, kinds, statuses, timestamps and counts only. Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== welcome pending inspection: one line per outbox row (digests only) =='

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

SELECT
  left(md5('te:' || t."id"::text), 8)                                        AS row_ref,
  t."kind",
  t."status",
  t."attempts",
  to_char(t."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"')                       AS recorded_at_utc,
  to_char(t."expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"')                       AS expires_at_utc,
  to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')               AS now_utc,
  (t."expiresAt" > timezone('UTC', now()))                                    AS still_sendable,
  round(extract(epoch FROM (t."expiresAt" - timezone('UTC', now()))) / 3600.0, 2) AS hours_until_expiry,
  t."sentAt" IS NOT NULL                                                       AS has_sent_at,
  t."providerMessageId" IS NOT NULL                                            AS has_provider_id,
  t."userId" IS NOT NULL                                                       AS names_a_user,
  left(md5('u:' || coalesce(t."userId"::text, '-')), 8)                       AS user_ref,
  round(extract(epoch FROM (t."createdAt" - u."createdAt")))                   AS seconds_after_user_created,
  round(extract(epoch FROM (t."createdAt" - b."createdAt")))                   AS seconds_after_business_created,
  u."termsAcceptedAt" IS NOT NULL                                              AS user_accepted_terms,
  round(extract(epoch FROM (t."createdAt" - u."termsAcceptedAt")))             AS seconds_after_terms,
  u."loginCount"                                                               AS user_login_count,
  u."lastLoginAt" IS NOT NULL                                                  AS user_has_signed_in,
  (u."emailVerifiedAt" IS NOT NULL)                                            AS user_email_verified,
  (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)           AS business_in_deletion,
  (t."toEmail" = u."email")                                                    AS addressed_to_users_current_email,
  (t."businessId" = u."businessId")                                            AS filed_under_users_business
FROM "TransactionalEmail" t
LEFT JOIN "User" u ON u."id" = t."userId"
LEFT JOIN "Business" b ON b."id" = t."businessId"
ORDER BY t."id"
LIMIT 50;

\echo '== summary: outbox rows by kind / status, and signups since the WELCOME code shipped (2026-10-08) =='

SELECT
  (SELECT count(*) FROM "TransactionalEmail")                                                    AS outbox_rows,
  (SELECT count(*) FROM "TransactionalEmail" WHERE "kind" = 'WELCOME')                          AS welcome_rows,
  (SELECT count(*) FROM "TransactionalEmail" WHERE "status" = 'PENDING')                        AS pending_rows,
  (SELECT count(*) FROM "TransactionalEmail" WHERE "status" = 'PENDING'
      AND "expiresAt" > timezone('UTC', now()))                                                 AS pending_and_still_sendable,
  (SELECT count(*) FROM "TransactionalEmail" WHERE "sentAt" IS NOT NULL)                         AS ever_sent,
  (SELECT count(*) FROM "User" WHERE "createdAt" >= timestamp '2026-10-08 00:00:00')             AS users_since_2026_10_08,
  (SELECT count(*) FROM "User" WHERE "termsAcceptedAt" >= timestamp '2026-10-08 00:00:00')       AS signups_with_terms_since_2026_10_08,
  (SELECT count(*) FROM "User")                                                                  AS users_total;

ROLLBACK;
