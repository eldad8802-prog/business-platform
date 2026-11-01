-- Read-only Production evidence (#36423501), needed before the PR #907 decision:
-- every BillingAuthorityConnection and BillingAuthorityApp, BOTH environments, by status,
-- with token presence only. Counts / booleans / PASS-FAIL only (evidence-output-guard):
-- no ids, no business ids, no timestamps, no secret material, nothing decrypted.
-- SELECT-only; READ ONLY transaction that rolls back.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT 'C1_connections_production' AS q,
  count(*) FILTER (WHERE environment = 'PRODUCTION')                                                  AS total_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'DISCONNECTED')                      AS disconnected_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'AUTHORIZATION_REQUIRED')            AS authorization_required_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'CONNECTED')                         AS connected_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'VALIDATED')                         AS validated_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'ERROR')                             AS error_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'REVOKED')                           AS revoked_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND "accessTokenEncrypted" IS NOT NULL)           AS access_token_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND "refreshTokenEncrypted" IS NOT NULL)          AS refresh_token_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND "oauthAuthorizedAt" IS NOT NULL)              AS oauth_authorized_count
FROM "BillingAuthorityConnection";

SELECT 'C2_connections_sandbox' AS q,
  count(*) FILTER (WHERE environment = 'SANDBOX')                                                     AS total_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'DISCONNECTED')                         AS disconnected_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'AUTHORIZATION_REQUIRED')               AS authorization_required_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'CONNECTED')                            AS connected_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'VALIDATED')                            AS validated_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'ERROR')                                AS error_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'REVOKED')                              AS revoked_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND "accessTokenEncrypted" IS NOT NULL)              AS access_token_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND "refreshTokenEncrypted" IS NOT NULL)             AS refresh_token_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND "oauthAuthorizedAt" IS NOT NULL)                 AS oauth_authorized_count
FROM "BillingAuthorityConnection";

SELECT 'C3_apps' AS q,
  count(*) FILTER (WHERE environment = 'PRODUCTION')                        AS production_total_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'ACTIVE')  AS production_active_count,
  count(*) FILTER (WHERE environment = 'SANDBOX')                           AS sandbox_total_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'ACTIVE')     AS sandbox_active_count
FROM "BillingAuthorityApp";

SELECT 'C4_verdict' AS q,
  CASE WHEN (SELECT count(*) FROM "BillingAuthorityConnection"
             WHERE "accessTokenEncrypted" IS NOT NULL OR "refreshTokenEncrypted" IS NOT NULL) = 0
       THEN 'PASS' ELSE 'FAIL' END                                             AS no_tokens_any_environment,
  CASE WHEN (SELECT count(*) FROM "BillingAuthorityConnection"
             WHERE status IN ('CONNECTED', 'VALIDATED')) = 0
       THEN 'PASS' ELSE 'FAIL' END                                             AS no_connected_any_environment;

ROLLBACK;
