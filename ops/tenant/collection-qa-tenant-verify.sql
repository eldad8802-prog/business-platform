-- Read-only verification of the Collection QA tenant.
--
-- Runs after the provisioning transaction has committed, in its own READ ONLY
-- transaction that always rolls back. It answers one question — "is there
-- exactly one QA tenant, correctly linked, able to log in?" — as a single
-- machine-checkable line the workflow compares against an expected string.
--
-- PRIVACY / SECRECY. The password hash is NEVER selected. Only two facts about
-- it are: that it is bcrypt at cost 10, and its length. Both are booleans or
-- integers, so the hash cannot be reconstructed from this output and cannot
-- appear in a workflow log.
--
-- Ids ARE printed. They are not secrets, and the owner needs them to address
-- the tenant in later evidence.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT
  'VERIFY'                                                  AS step,
  (SELECT count(*) FROM "User" u WHERE u."email" = :'qa_email')            AS user_count,
  (SELECT count(*) FROM "Business" b WHERE b."name" = :'qa_business_name') AS business_count,
  u.id                                                      AS user_id,
  b.id                                                      AS business_id,
  (u."businessId" = b.id)                                   AS link_ok,
  u."role"::text                                            AS role,
  u."tokenVersion"                                          AS token_version,
  u."loginCount"                                            AS login_count,
  (u."lastLoginAt" IS NULL)                                 AS never_logged_in,
  (u."password" ~ '^\$2[aby]\$10\$')                        AS bcrypt_cost_10,
  length(u."password")                                      AS hash_length,
  (b."name" = :'qa_business_name')                          AS business_name_ok,
  (u."name" = :'qa_user_name')                              AS user_name_ok,
  (b."deletedAt" IS NULL AND b."archivedAt" IS NULL)        AS business_live,
  (SELECT count(*) FROM "BusinessPaymentConnection" c WHERE c."businessId" = b.id) AS payment_connections,
  (SELECT count(*) FROM "BillingDocument" d WHERE d."businessId" = b.id)           AS billing_documents,
  (SELECT count(*) FROM "PaymentRequest" p WHERE p."businessId" = b.id)            AS payment_requests
FROM "User" u
JOIN "Business" b ON b.id = u."businessId"
WHERE u."email" = :'qa_email';

ROLLBACK;
