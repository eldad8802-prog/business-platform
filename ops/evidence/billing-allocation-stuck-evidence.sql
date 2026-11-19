-- ============================================================================
-- billing-allocation-stuck-evidence.sql
--
-- Read-only Production evidence: are there issued invoices whose final PDF cannot be delivered
-- because of their allocation-number (מספר הקצאה) state — and what is known about each state?
--
-- Background: before the issue-time allocation gate (#1076), an invoice that needed an
-- allocation number was issued even when the Approval could not be sent (Production pilot gate),
-- took its number, and stayed READY: never sent, PDF refused for good. This file counts such
-- documents, and every other non-deliverable allocation state, so the owner can decide
-- about them. It decides nothing and changes nothing: no send, no credit, no cancel, no re-issue.
--
-- The deliverability rule mirrored here is evaluateAuthorityDeliverability
-- (lib/services/billing/authority/billing-authority-delivery.rules.ts):
--   deliverable = NOT_REQUIRED, APPROVED with an allocation number on the document,
--                 or HELD with a reported PROCEED_WITHOUT_ALLOCATION decision;
--   blocked     = everything else, incl. an eligible document with no submission row.
-- Eligible document types: TAX_INVOICE, TAX_INVOICE_RECEIPT.
--
-- Counts and day-counts only (scripts/ci/evidence-redact.mjs): no id, name, amount, number,
-- token, payload, error message or response. errorCode is only MATCHED against our own
-- internal prefixes; it is never printed.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== billing allocation state of issued eligible invoices: legend =='
\echo ' 1 issued TAX_INVOICE + TAX_INVOICE_RECEIPT (count)'
\echo ' 2 ... with no submission row (count; blocked by rule)'
\echo ' 3 ... NOT_REQUIRED (count; deliverable)'
\echo ' 4 ... READY (count; blocked: never sent)'
\echo ' 5 ... READY with no recorded attempt (lastAttemptAt null) (count)'
\echo ' 6 ... PENDING (count; blocked)'
\echo ' 7 ... SUBMITTED, no uncertain marker (count; blocked: answer awaited)'
\echo ' 8 ... SUBMITTED with an AUTHORITY_OUTCOME_UNCERTAIN_* marker (count; blocked: may have reached ITA, never resent)'
\echo ' 9 ... FAILED with an AUTHORITY_NOT_SENT_* code (count; blocked: provably not sent)'
\echo '10 ... FAILED with any other code (count; blocked: may have been sent)'
\echo '11 ... HELD, no reported decision (count; blocked: decision needed)'
\echo '12 ... HELD with a reported PROCEED_WITHOUT_ALLOCATION decision (count; deliverable without a number)'
\echo '13 ... REJECTED (count; blocked)'
\echo '14 ... APPROVED with an allocation number on the document (count; deliverable)'
\echo '15 ... APPROVED with NO allocation number on the document (count; blocked: inconsistent)'
\echo '16 blocked in total, by the rule above (count)'
\echo '17 blocked TAX_INVOICE (count)'
\echo '18 blocked TAX_INVOICE_RECEIPT (count)'
\echo '19 businesses with at least one blocked invoice (count)'
\echo '20 blocked invoices with a payment request linked to them (count)'
\echo '21 blocked invoices whose PDF was ever rendered (pdfRenderStatus RENDERED) (count; must be 0)'
\echo '22 days since the most recently issued blocked invoice (count; null = none)'
\echo '23 days since the oldest blocked invoice was issued (count; null = none)'
\echo '24 submissions with an Approval payload hash recorded (send was reserved) among blocked (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
docs AS (
  SELECT d."id", d."businessId", d."documentType"::text AS t, d."allocationNumber" AS alloc,
         d."pdfRenderStatus"::text AS pdf, d."issuedAt" AS issued_at,
         s."status"::text AS st, s."errorCode" AS code, s."lastAttemptAt" AS attempt,
         s."heldDecisionType"::text AS held_type, s."heldDecisionReportedAt" AS held_at,
         s."authorityPayloadHash" AS payload_hash
    FROM "BillingDocument" d
    LEFT JOIN "BillingAuthoritySubmission" s ON s."billingDocumentId" = d."id"
   WHERE d."status"::text = 'ISSUED' AND d."documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT')
),
judged AS (
  SELECT docs.*,
         NOT (
           st = 'NOT_REQUIRED'
           OR (st = 'APPROVED' AND coalesce(btrim(alloc), '') <> '')
           OR (st = 'HELD' AND held_type = 'PROCEED_WITHOUT_ALLOCATION' AND held_at IS NOT NULL)
         ) OR st IS NULL AS blocked
    FROM docs
),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM judged)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM judged WHERE st IS NULL)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM judged WHERE st = 'NOT_REQUIRED')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM judged WHERE st = 'READY')
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM judged WHERE st = 'READY' AND attempt IS NULL)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM judged WHERE st = 'PENDING')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM judged WHERE st = 'SUBMITTED' AND coalesce(code, '') NOT LIKE 'AUTHORITY\_OUTCOME\_UNCERTAIN\_%')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM judged WHERE st = 'SUBMITTED' AND code LIKE 'AUTHORITY\_OUTCOME\_UNCERTAIN\_%')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM judged WHERE st = 'FAILED' AND code LIKE 'AUTHORITY\_NOT\_SENT\_%')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM judged WHERE st = 'FAILED' AND coalesce(code, '') NOT LIKE 'AUTHORITY\_NOT\_SENT\_%')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM judged WHERE st = 'HELD' AND NOT (held_type = 'PROCEED_WITHOUT_ALLOCATION' AND held_at IS NOT NULL))
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM judged WHERE st = 'HELD' AND held_type = 'PROCEED_WITHOUT_ALLOCATION' AND held_at IS NOT NULL)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM judged WHERE st = 'REJECTED')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM judged WHERE st = 'APPROVED' AND coalesce(btrim(alloc), '') <> '')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM judged WHERE st = 'APPROVED' AND coalesce(btrim(alloc), '') = '')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM judged WHERE blocked)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM judged WHERE blocked AND t = 'TAX_INVOICE')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM judged WHERE blocked AND t = 'TAX_INVOICE_RECEIPT')
  UNION ALL SELECT 19, NULL, (SELECT count(DISTINCT "businessId") FROM judged WHERE blocked)
  UNION ALL SELECT 20, NULL, (SELECT count(DISTINCT j."id") FROM judged j JOIN "PaymentRequest" p ON p."billingDocumentId" = j."id" WHERE j.blocked)
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM judged WHERE blocked AND pdf = 'RENDERED')
  UNION ALL SELECT 22, NULL, (SELECT (current_date - max(issued_at)::date)::bigint FROM judged WHERE blocked AND issued_at IS NOT NULL)
  UNION ALL SELECT 23, NULL, (SELECT (current_date - min(issued_at)::date)::bigint FROM judged WHERE blocked AND issued_at IS NOT NULL)
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM judged WHERE blocked AND payload_hash IS NOT NULL)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
