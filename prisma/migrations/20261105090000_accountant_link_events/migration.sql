-- Accountant portal (R2) — two audit event types for the accountant's link
--
-- WHAT THIS CHANGES (one CHECK constraint; nothing else)
--   "AccountantWorkflowEvent_type" gains two values, every existing value kept:
--     LINK_VIEWED           the accountant opened the portal of a delivered package (the list of files);
--     LINK_FILE_DOWNLOADED  the accountant viewed or downloaded ONE file of it — a source document, an issued
--                           document, or the Excel / PDF report. The ZIP download stays LINK_DOWNLOADED.
--   The payload stays closed by "AccountantWorkflowEvent_payload_closed" (ids, counts and short codes only),
--   and the trail stays append-only (its triggers are untouched).
--
-- WHY A CONSTRAINT SWAP
--   The list is a CHECK constraint (20261027090000_accountant_month_close). PostgreSQL cannot extend one in
--   place, so this drops it and adds it again under the same name with a superset list, in ONE statement:
--   every existing row satisfies the new list, so validation cannot fail, and there is no moment without
--   the check. No table rewrite (a CHECK is validated by a scan under the statement's lock).
--
-- ISOLATION / AUTHORITY
--   Unchanged: no role, grant, policy, RLS setting, function or owner is touched.
--
-- Rollback (owner-run): the same statement with the 2026-10-27 list — refuses while a row uses a new value.

ALTER TABLE "AccountantWorkflowEvent"
  DROP CONSTRAINT "AccountantWorkflowEvent_type",
  ADD CONSTRAINT "AccountantWorkflowEvent_type" CHECK ("eventType" IN (
    'PERIOD_EVALUATED', 'PACKAGE_BUILT', 'PACKAGE_BUILD_FAILED', 'PACKAGE_SUPERSEDED', 'PACKAGE_DOWNLOADED_BY_OWNER',
    'ISSUED_PDFS_PREPARED', 'NOTIFIED', 'REMINDED', 'CHANGED_AFTER_SEND',
    'RECIPIENT_SET', 'RECIPIENT_CHANGED',
    'DELIVERY_APPROVED', 'DELIVERY_CANCELED', 'DELIVERY_SENDING', 'DELIVERY_RETRY_SCHEDULED', 'DELIVERY_ACCEPTED',
    'DELIVERY_DELIVERED', 'DELIVERY_BOUNCED', 'DELIVERY_FAILED',
    'LINK_DOWNLOADED', 'LINK_REFUSED', 'LINK_REVOKED',
    'PERIOD_COMPLETED', 'PERIOD_COMPLETED_MANUALLY',
    'LINK_VIEWED', 'LINK_FILE_DOWNLOADED'));
