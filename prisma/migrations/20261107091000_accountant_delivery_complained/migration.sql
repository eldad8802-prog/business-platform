-- Accountant package — the recipient's spam complaint as an audit event (G5 milestone 1, M1)
--
-- WHAT THIS CHANGES (one CHECK constraint; nothing else)
--   "AccountantWorkflowEvent_type" gains one value, every existing value kept:
--     DELIVERY_COMPLAINED  the email provider reported that the recipient marked the accountant's email as spam
--                          (Resend `email.complained`). It is an audit fact only: the delivery's status is NOT
--                          changed (no new delivery status — owner decision, 2026-10-28).
--   The payload stays closed by "AccountantWorkflowEvent_payload_closed" (ids, counts and short codes only),
--   and the trail stays append-only (its triggers are untouched).
--
-- WHY A CONSTRAINT SWAP
--   As in 20261105090000_accountant_link_events: PostgreSQL cannot extend a CHECK in place, so it is dropped and
--   added again under the same name with a superset list, in ONE statement. Every existing row satisfies the new
--   list, so validation cannot fail, and there is no moment without the check.
--
-- ISOLATION / AUTHORITY
--   Unchanged: no role, grant, policy, RLS setting, function or owner is touched.
--
-- Rollback (owner-run): .acct/complained-rollback.sql — the 2026-11-05 list; refuses while a row uses the new value.

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
    'LINK_VIEWED', 'LINK_FILE_DOWNLOADED',
    'DELIVERY_COMPLAINED'));
