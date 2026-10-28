-- ============================================================================
-- accountant-g4-pilot-postcheck.sql
--
-- Read-only Production evidence AFTER the first accountant send (G4 pilot): business 9, September 2026.
-- What was sent, to whom, which package, how the provider answered, what the accountant's link did, and
-- that nothing reached any other business.
--
--   * exactly one delivery, of business 9, for September, to the chosen address (sha256 of the normalised
--     address — the address is in neither this file nor the output), of the READY package version 1 with
--     its exact sealed sha256;
--   * its status (accepted / delivered), its attempts, a provider message id, no failure, no duplicate;
--   * its link: valid 14 days from the approval, revoked or not, the ZIP download count;
--   * the trail of that delivery, by event type (counts only);
--   * the package and the month: still version 1, 5 files, sealed, the month SENT;
--   * the feature and isolation: one override (business 9), nothing of any other business.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id, token, link, path or text. Guard-clean: no
-- write keyword anywhere, prose included. Nothing is changed.
--
-- OUTPUT: n | flag | observed_count.
-- ============================================================================

\echo '== accountant G4 pilot postcheck (business 9, 2026-09): legend =='
\echo ' 1 deliveries, all businesses (count; expected 1)'
\echo ' 2 deliveries of business 9 for 2026-09 (count; expected 1)'
\echo ' 3 its recipient is the chosen address (sha256 of the normalised address matches) (flag)'
\echo ' 4 it carries the READY package of 2026-09: same package, version 1, same sealed sha256 (flag)'
\echo ' 5 status ACCEPTED (flag)'
\echo ' 6 status DELIVERED (flag)'
\echo ' 7 send attempts (count; expected 1)'
\echo ' 8 a provider message id was recorded and no failure code (flag)'
\echo ' 9 the link expires exactly 14 days after the approval (flag)'
\echo '10 the link is revoked (flag)'
\echo '11 the link has expired (flag)'
\echo '12 ZIP downloads through the link (count)'
\echo '13 trail of that delivery: DELIVERY_APPROVED (count; expected 1)'
\echo '14 trail: DELIVERY_SENDING (count; expected 1)'
\echo '15 trail: DELIVERY_ACCEPTED (count; expected 1)'
\echo '16 trail: DELIVERY_RETRY_SCHEDULED + DELIVERY_FAILED + DELIVERY_BOUNCED (count; expected 0)'
\echo '17 trail: LINK_VIEWED — the portal opened (count)'
\echo '18 trail: LINK_FILE_DOWNLOADED — files / reports viewed or downloaded (count)'
\echo '19 trail: LINK_DOWNLOADED — the ZIP (count)'
\echo '20 trail: LINK_REFUSED (count)'
\echo '21 trail: PERIOD_COMPLETED for the month (count; expected 1)'
\echo '22 the month is SENT (flag)'
\echo '23 the package is unchanged: one READY package, version 1, 5 records, 5 files, 0 missing, sealed (flag)'
\echo '24 the approval needed no "send anyway" (0 open items, not acknowledged as incomplete) (flag)'
\echo '25 accountant_month_close overrides: exactly one, business 9 ENABLED (flag)'
\echo '26 accountant rows of any OTHER business: periods + packages + recipients + deliveries + trail (count; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
per AS (SELECT p.* FROM "AccountantPeriod" p WHERE p."businessId" = 9 AND p."periodKey" = '2026-09'),
pkg AS (SELECT k.* FROM "AccountantPackage" k JOIN per ON per."id" = k."periodId" WHERE k.status = 'READY'),
dlv AS (SELECT d.* FROM "AccountantDelivery" d JOIN per ON per."id" = d."periodId" WHERE d."businessId" = 9),
ev AS (SELECT e."eventType" AS t FROM "AccountantWorkflowEvent" e JOIN dlv ON dlv."id" = e."deliveryId" WHERE e."businessId" = 9),
ovr AS (SELECT a.* FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'accountant_month_close'),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM "AccountantDelivery")
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM dlv)
  UNION ALL SELECT 3, (SELECT bool_and(encode(sha256(convert_to(lower(btrim("recipientEmail")), 'UTF8')), 'hex')
                                       = '92d7e928efff9443ce4d61b19aca3e69a0ee4cf34eb5361ddc29b80756defab5') FROM dlv), NULL
  UNION ALL SELECT 4, (SELECT bool_and(d."packageId" = k."id" AND d."packageVersion" = 1 AND k."version" = 1 AND d."packageSha256" = k."sha256")
                       FROM dlv d, pkg k), NULL
  UNION ALL SELECT 5, (SELECT bool_and(status = 'ACCEPTED') FROM dlv), NULL
  UNION ALL SELECT 6, (SELECT bool_and(status = 'DELIVERED') FROM dlv), NULL
  UNION ALL SELECT 7, NULL, (SELECT max(attempts) FROM dlv)
  UNION ALL SELECT 8, (SELECT bool_and("providerMessageId" IS NOT NULL AND "failureCode" IS NULL) FROM dlv), NULL
  UNION ALL SELECT 9, (SELECT bool_and("linkExpiresAt" = "approvedAt" + interval '14 days') FROM dlv), NULL
  UNION ALL SELECT 10, (SELECT bool_and("linkRevokedAt" IS NOT NULL) FROM dlv), NULL
  UNION ALL SELECT 11, (SELECT bool_and("linkExpiresAt" <= (now() AT TIME ZONE 'UTC')) FROM dlv), NULL
  UNION ALL SELECT 12, NULL, (SELECT max("downloadCount") FROM dlv)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM ev WHERE t = 'DELIVERY_APPROVED')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM ev WHERE t = 'DELIVERY_SENDING')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM ev WHERE t = 'DELIVERY_ACCEPTED')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM ev WHERE t IN ('DELIVERY_RETRY_SCHEDULED', 'DELIVERY_FAILED', 'DELIVERY_BOUNCED'))
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM ev WHERE t = 'LINK_VIEWED')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM ev WHERE t = 'LINK_FILE_DOWNLOADED')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM ev WHERE t = 'LINK_DOWNLOADED')
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM ev WHERE t = 'LINK_REFUSED')
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM "AccountantWorkflowEvent" e JOIN per ON per."id" = e."periodId" WHERE e."businessId" = 9 AND e."eventType" = 'PERIOD_COMPLETED')
  UNION ALL SELECT 22, (SELECT bool_and(status = 'SENT') FROM per), NULL
  UNION ALL SELECT 23, (SELECT count(*) = 1 AND bool_and(version = 1 AND (manifest->>'recordCount')::int = 5 AND (manifest->>'approvedFiles')::int = 5
                                AND (manifest->>'missingFiles')::int = 0 AND "sizeBytes" > 0 AND length("sha256") = 64) FROM pkg), NULL
  UNION ALL SELECT 24, (SELECT bool_and("openItemCount" = 0 AND NOT "incompleteAcknowledged") FROM dlv), NULL
  UNION ALL SELECT 25, (SELECT count(*) = 1 AND bool_and("businessId" = 9 AND state::text = 'ENABLED') FROM ovr), NULL
  UNION ALL SELECT 26, NULL, (SELECT (SELECT count(*) FROM "AccountantPeriod" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantPackage" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "businessId" <> 9))
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
