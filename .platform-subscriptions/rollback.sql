-- Platform subscriptions — rollback of 20261224090000_platform_subscriptions. Drops exactly what the migration created.
-- Additive migration: nothing else depends on these objects (the code that reads them treats "no table" as "no record",
-- i.e. today's access, and logs subscription_read_failed). Run in one transaction as the migration owner; then delete
-- the ledger row 20261224090000_platform_subscriptions.
\set ON_ERROR_STOP 1
DROP TABLE "PlatformSubscriptionEvent";
DROP TABLE "PlatformSubscription";
DROP FUNCTION public.platform_subscription_event_append_only();
SELECT 'ROLLBACK_OK' AS result;
