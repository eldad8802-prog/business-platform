-- Rollback of 20261109091000_accountant_link_otp (owner-run). Removes the code and device tables and restores the
-- 2026-11-07 event-type list. Refuses while either table holds a row or a trail row uses a new value: codes sent and
-- devices verified are security records, so once the portal has used them the rollback is a decision, not a script.
BEGIN;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountantLinkChallenge") OR EXISTS (SELECT 1 FROM "AccountantLinkDevice") THEN
    RAISE EXCEPTION 'ACCOUNTANT_OTP_ROLLBACK_REFUSED: codes or devices exist; nothing was changed';
  END IF;
END
$do$;
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
DROP TABLE "AccountantLinkDevice";
DROP TABLE "AccountantLinkChallenge";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261109091000_accountant_link_otp';
COMMIT;
