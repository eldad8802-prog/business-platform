-- Rollback of 20261107091000_accountant_delivery_complained (owner-run). Restores the 2026-11-05 event-type list.
-- Refuses (the CHECK cannot validate) while any trail row uses DELIVERY_COMPLAINED: the trail is append-only, so
-- once a complaint was recorded the rollback is a decision, not a script.
BEGIN;
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
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107091000_accountant_delivery_complained';
COMMIT;
