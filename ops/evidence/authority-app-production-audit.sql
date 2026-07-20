-- Read-only Production audit of BillingAuthorityApp (environment=PRODUCTION).
-- Returns ONLY presence booleans, status, last-4 masks of non-secret ids, and
-- timestamps. NEVER any part of the client secret, IV, or tag; never decrypts.
-- SELECT-only; READ ONLY transaction that rolls back; a static guard rejects any
-- write keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT 'P1_authority_app_production' AS q,
  (count(*) > 0)                                                        AS production_row_exists,
  bool_or(id IS NOT NULL)                                               AS id_present,
  max(environment::text)                                                AS environment,
  max(status::text)                                                     AS status,
  bool_or("accountingSoftwareNumber" IS NOT NULL
          AND length(btrim("accountingSoftwareNumber")) > 0)            AS acct_sw_present,
  max(right("accountingSoftwareNumber", 4))                             AS acct_sw_last4,
  bool_or("itaClientId" IS NOT NULL
          AND length(btrim("itaClientId")) > 0)                         AS ita_client_id_present,
  max(right("itaClientId", 4))                                          AS ita_client_id_last4,
  bool_or("clientSecretEncrypted" IS NOT NULL)                          AS encrypted_secret_present,
  bool_or("clientSecretIv" IS NOT NULL)                                 AS iv_present,
  bool_or("clientSecretTag" IS NOT NULL)                                AS tag_present,
  bool_or("encryptionKeyId" IS NOT NULL)                                AS encryption_key_id_present,
  bool_or("portalOrganizationId" IS NOT NULL)                           AS portal_org_present,
  max(right("portalOrganizationId", 4))                                 AS portal_org_last4,
  bool_or("portalApplicationId" IS NOT NULL)                            AS portal_app_present,
  max(right("portalApplicationId", 4))                                  AS portal_app_last4,
  max("registeredAt"::text)                                            AS registered_at,
  max("createdAt"::text)                                               AS created_at,
  max("updatedAt"::text)                                               AS updated_at
FROM "BillingAuthorityApp"
WHERE environment = 'PRODUCTION';

ROLLBACK;
