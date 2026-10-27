-- Rollback of 20261105090000_accountant_link_events (owner-run). Restores the 2026-10-27 event-type list.
-- Refuses (the CHECK cannot validate) while any trail row uses LINK_VIEWED or LINK_FILE_DOWNLOADED: the
-- trail is append-only, so once the portal has recorded an access the rollback is a decision, not a script.
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
    'PERIOD_COMPLETED', 'PERIOD_COMPLETED_MANUALLY'));
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events';
COMMIT;
