-- Read-only verification of the Collection QA tenant password repair.
--
-- Answers three questions the repair must be able to answer afterwards: the
-- credential is now a bcrypt cost-10 hash, it is a DIFFERENT one than before,
-- and nothing else about the account moved.
--
-- The hash is never selected. `md5(...)` here is not a security control — it is
-- a fingerprint, so the run can prove the value CHANGED without printing it,
-- and so two runs can be told apart. Comparing it to the fingerprint the
-- provisioning verification would have produced is what distinguishes "the
-- repair worked" from "the repair ran and changed nothing".

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT
  'VERIFY_PASSWORD'                                         AS step,
  (SELECT count(*) FROM "User" u WHERE u."email" = :'qa_email')            AS user_count,
  (SELECT count(*) FROM "Business" b WHERE b."name" = :'qa_business_name') AS business_count,
  u."id"                                                    AS user_id,
  b."id"                                                    AS business_id,
  (u."businessId" = b."id")                                 AS link_ok,
  u."role"::text                                            AS role,
  u."tokenVersion"                                          AS token_version,
  u."loginCount"                                            AS login_count,
  (u."password" ~ '^\$2[aby]\$10\$')                        AS bcrypt_cost_10,
  length(u."password")                                      AS hash_length,
  left(md5(u."password"), 8)                                AS hash_fingerprint,
  (u."name" = :'qa_user_name')                              AS user_name_ok,
  (b."name" = :'qa_business_name')                          AS business_name_ok,
  (b."deletedAt" IS NULL AND b."archivedAt" IS NULL)        AS business_live,
  (SELECT count(*) FROM "BusinessPaymentConnection" c WHERE c."businessId" = b."id") AS payment_connections,
  (SELECT count(*) FROM "BillingDocument" d WHERE d."businessId" = b."id")           AS billing_documents,
  (SELECT count(*) FROM "PaymentRequest" p WHERE p."businessId" = b."id")            AS payment_requests
FROM "User" u
JOIN "Business" b ON b."id" = u."businessId"
WHERE u."id" = :qa_user_id
  AND u."email" = :'qa_email';

ROLLBACK;
