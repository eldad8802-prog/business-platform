-- Read-only Production evidence for the last Billing-Authority OAuth attempt.
-- Purpose: identify the failing stage of the SANDBOX OAuth connect that ended
-- in status=ERROR, WITHOUT exposing any secret material.
--
-- Safety: SELECT-only; READ ONLY transaction that rolls back; a static guard in
-- the workflow rejects any write keyword before this file reaches the database.
-- No tokens, no ciphertext, no client secret, no OAuth code/state, no PII values
-- are selected. Only presence booleans, statuses, safe internal error codes, and
-- timestamps.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

-- A1: Platform app configuration for SANDBOX (present/missing only, no values).
SELECT 'A1_app_sandbox' AS q,
  count(*)                                                              AS rows,
  bool_or(status = 'ACTIVE')                                           AS any_active,
  bool_or(status = 'DISABLED')                                         AS any_disabled,
  bool_or("itaClientId" IS NOT NULL
          AND length(btrim("itaClientId")) > 0)                        AS has_client_id,
  bool_or("clientSecretEncrypted" IS NOT NULL
          AND "clientSecretIv" IS NOT NULL
          AND "clientSecretTag" IS NOT NULL)                           AS has_encrypted_secret,
  bool_or("encryptionKeyId" IS NOT NULL)                               AS has_encryption_key_id,
  bool_or("accountingSoftwareNumber" IS NOT NULL
          AND length(btrim("accountingSoftwareNumber")) > 0)           AS has_accounting_sw_number,
  bool_or("portalOrganizationId" IS NOT NULL)                          AS has_portal_org,
  bool_or("portalApplicationId" IS NOT NULL)                           AS has_portal_app,
  bool_or("registeredAt" IS NOT NULL)                                  AS has_registered_at
FROM "BillingAuthorityApp"
WHERE environment = 'SANDBOX';

-- A2: All SANDBOX connections (safe fields only). lastErrorCode is a safe internal
-- code (e.g. AUTHORITY_OAUTH_TOKEN_EXCHANGE_FAILED) — never a secret. This is the
-- decisive evidence for the failing stage.
SELECT 'A2_connection' AS q,
  "businessId"                                    AS business_id,
  status,
  ("oauthAuthorizedAt" IS NOT NULL)               AS has_oauth_authorized_at,
  "oauthAuthorizedAt"                             AS oauth_authorized_at,
  ("accessTokenEncrypted" IS NOT NULL)            AS has_access_token_at_rest,
  ("refreshTokenEncrypted" IS NOT NULL)           AS has_refresh_token_at_rest,
  "accessTokenExpiresAt"                          AS access_expires_at,
  "refreshTokenExpiresAt"                         AS refresh_expires_at,
  "revokedAt"                                     AS revoked_at,
  "lastErrorCode"                                 AS last_error_code,
  "lastValidatedAt"                               AS last_validated_at,
  "lastTokenRefreshAt"                            AS last_token_refresh_at,
  "createdAt"                                     AS created_at,
  "updatedAt"                                     AS updated_at
FROM "BillingAuthorityConnection"
WHERE environment = 'SANDBOX'
ORDER BY "updatedAt" DESC;

-- A3: Recent Billing-Authority audit events (eventType + timestamps only; no
-- summary/metadata to stay clear of any incidental identifiers).
SELECT 'A3_audit' AS q,
  "businessId"    AS business_id,
  "eventType"     AS event_type,
  source,
  "occurredAt"    AS occurred_at
FROM "BillingAuditEvent"
WHERE "eventType" LIKE 'BILLING_AUTHORITY_%'
ORDER BY "occurredAt" DESC
LIMIT 25;

-- A4: Count of Billing-Authority audit events by type (shape of the trail).
SELECT 'A4_audit_by_type' AS q,
  "eventType"   AS event_type,
  count(*)      AS n,
  max("occurredAt") AS latest
FROM "BillingAuditEvent"
WHERE "eventType" LIKE 'BILLING_AUTHORITY_%'
GROUP BY "eventType"
ORDER BY max("occurredAt") DESC;

ROLLBACK;
